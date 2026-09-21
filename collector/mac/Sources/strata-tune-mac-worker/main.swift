// strata-tune-mac-worker: the macOS twin of StrataTune.Worker and StrataTune.Bench.
//
//   --info --json                          the Metal device: name, unified memory, working-set size
//   --bench --json                         stream-copy bandwidth and MPS matmul throughput (one JSON line last)
//   --load <light|heavy|cpu|fillrate> --seconds N
//                                          the audit's load kernels; fillrate prints one JSON line at the end
//
// Exit codes match the Windows worker where the shell reads them: 0 ok, 2 bad arguments, 3 no GPU.
// Nothing here writes to the hardware; Metal has no clock or power controls to write.
import Foundation
import Metal
import MetalPerformanceShaders

let args = CommandLine.arguments.dropFirst()
func flag(_ name: String) -> Bool { args.contains(name) }
func value(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.endIndex else { return nil }
    return args[args.index(after: i)]
}
func fail(_ message: String, code: Int32) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}
func jsonLine(_ object: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
    fflush(stdout)
}

guard let device = MTLCreateSystemDefaultDevice() else { fail("No Metal device", code: 3) }
guard let queue = device.makeCommandQueue() else { fail("No Metal command queue", code: 3) }

let kernels = """
#include <metal_stdlib>
using namespace metal;
kernel void copyk(device const float4* a [[buffer(0)]], device float4* b [[buffer(1)]], uint i [[thread_position_in_grid]]) { b[i] = a[i]; }
kernel void spin(device float* a [[buffer(0)]], constant uint& rounds [[buffer(1)]], uint i [[thread_position_in_grid]]) {
  float x = a[i] * 0.5f + 0.25f;
  for (uint r = 0; r < rounds; r++) x = 3.9f * x * (1.0f - x);
  a[i] = x;
}
struct V { float4 pos [[position]]; };
vertex V fullscreen(uint vid [[vertex_id]]) {
  float2 p[6] = { float2(-1,-1), float2(1,-1), float2(-1,1), float2(-1,1), float2(1,-1), float2(1,1) };
  V v; v.pos = float4(p[vid % 6], 0, 1); return v;
}
fragment float4 fill(V in [[stage_in]], constant float& t [[buffer(0)]]) { return float4(fract(in.pos.x * 0.001f + t), fract(in.pos.y * 0.001f), t, 1); }
"""
let library: MTLLibrary
do { library = try device.makeLibrary(source: kernels, options: nil) } catch { fail("Metal compile failed: \(error)", code: 3) }
func pipeline(_ name: String) -> MTLComputePipelineState {
    do { return try device.makeComputePipelineState(function: library.makeFunction(name: name)!) } catch { fail("pipeline \(name): \(error)", code: 3) }
}

// MARK: - info

func info() -> [String: Any] {
    return [
        "device": device.name,
        "luid": String(format: "%016llx", device.registryID),
        "unified": device.hasUnifiedMemory,
        "recommendedMaxWorkingSetBytes": Int(device.recommendedMaxWorkingSetSize),
        "maxBufferBytes": Int(device.maxBufferLength),
        "lowPower": device.isLowPower
    ]
}

// MARK: - bench

/// STREAM-style copy: every element read once and written once, so bytes moved = 2 x buffer. Best and median of the passes.
func copyBandwidth(bufferBytes: Int, passes: Int) -> (best: Double, median: Double) {
    let pso = pipeline("copyk")
    let n = bufferBytes / 16
    guard let a = device.makeBuffer(length: n * 16, options: .storageModePrivate), let b = device.makeBuffer(length: n * 16, options: .storageModePrivate) else { fail("Could not allocate \(bufferBytes) bytes", code: 3) }
    var rates: [Double] = []
    for _ in 0..<passes {
        let cb = queue.makeCommandBuffer()!
        let enc = cb.makeComputeCommandEncoder()!
        enc.setComputePipelineState(pso)
        enc.setBuffer(a, offset: 0, index: 0)
        enc.setBuffer(b, offset: 0, index: 1)
        enc.dispatchThreads(MTLSize(width: n, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: pso.maxTotalThreadsPerThreadgroup, height: 1, depth: 1))
        enc.endEncoding()
        cb.commit()
        cb.waitUntilCompleted()
        let s = cb.gpuEndTime - cb.gpuStartTime
        if s > 0 { rates.append(Double(2 * n * 16) / s / 1e9) }
    }
    rates.sort()
    return (rates.last ?? 0, rates.isEmpty ? 0 : rates[rates.count / 2])
}

/// MPS matmul of two N x N matrices: 2N^3 flops per pass. fp16 is half storage with the same kernel, the Windows worker's "fp16storage".
func matmulTflops(n: Int, half: Bool, passes: Int) -> Double {
    let bytes = half ? 2 : 4
    let desc = MPSMatrixDescriptor(rows: n, columns: n, rowBytes: n * bytes, dataType: half ? .float16 : .float32)
    func matrix() -> MPSMatrix { MPSMatrix(buffer: device.makeBuffer(length: n * n * bytes, options: .storageModePrivate)!, descriptor: desc) }
    let (a, b, c) = (matrix(), matrix(), matrix())
    let mm = MPSMatrixMultiplication(device: device, transposeLeft: false, transposeRight: false, resultRows: n, resultColumns: n, interiorColumns: n, alpha: 1, beta: 0)
    var best = 0.0
    for _ in 0..<passes {
        let cb = queue.makeCommandBuffer()!
        mm.encode(commandBuffer: cb, leftMatrix: a, rightMatrix: b, resultMatrix: c)
        cb.commit()
        cb.waitUntilCompleted()
        let s = cb.gpuEndTime - cb.gpuStartTime
        if s > 0 { best = max(best, 2.0 * Double(n) * Double(n) * Double(n) / s / 1e12) }
    }
    return best
}

/// Metal 4 tensor ops (MetalPerformancePrimitives, macOS 26): the GPU's matrix path at int8 with int32
/// accumulate, the precision a PC's "AI TOPS" quotes, and fp16 through the same path. 128 x 64 tiles, four
/// SIMD-groups per threadgroup, the op looping over K itself. Nil where the shading language or the
/// primitives are older than Metal 4 (the source then fails to compile and the bench line omits the figures).
let tensorKernels = """
#include <metal_stdlib>
#include <MetalPerformancePrimitives/MetalPerformancePrimitives.h>
using namespace metal;
using namespace mpp;
using namespace mpp::tensor_ops;
template <typename TA, typename TC>
static inline void mm_tile(device TA* a, device TA* b, device TC* c, uint n, uint2 tgid) {
  auto A = tensor<device TA, dextents<int32_t, 2>, tensor_inline>(a, dextents<int32_t, 2>(int(n), int(n)));
  auto B = tensor<device TA, dextents<int32_t, 2>, tensor_inline>(b, dextents<int32_t, 2>(int(n), int(n)));
  auto C = tensor<device TC, dextents<int32_t, 2>, tensor_inline>(c, dextents<int32_t, 2>(int(n), int(n)));
  // 128 x 64 tiles over four SIMD-groups, the op looping over the whole K itself: the best of the
  // shapes tried on the M5 Max (122 int8 TOPS against 97 for 64 x 64; a fixed k tile without an
  // outer loop only multiplies a slice and must not be used for a throughput figure).
  constexpr auto d = matmul2d_descriptor(128, 64, static_cast<int>(dynamic_extent));
  matmul2d<d, execution_simdgroups<4>> op;
  auto tA = A.slice(0, int(tgid.y * 128));
  auto tB = B.slice(int(tgid.x * 64), 0);
  auto tC = C.slice(int(tgid.x * 64), int(tgid.y * 128));
  op.run(tA, tB, tC);
}
kernel void mm_i8(device int8_t* a [[buffer(0)]], device int8_t* b [[buffer(1)]], device int32_t* c [[buffer(2)]], constant uint& n [[buffer(3)]], uint2 tgid [[threadgroup_position_in_grid]]) { mm_tile<int8_t, int32_t>(a, b, c, n, tgid); }
kernel void mm_f16(device half* a [[buffer(0)]], device half* b [[buffer(1)]], device float* c [[buffer(2)]], constant uint& n [[buffer(3)]], uint2 tgid [[threadgroup_position_in_grid]]) { mm_tile<half, float>(a, b, c, n, tgid); }
"""

func tensorOps(n: Int, passes: Int) -> (int8Tops: Double, fp16Tflops: Double)? {
    guard #available(macOS 26.0, *) else { return nil }
    let opts = MTLCompileOptions()
    opts.languageVersion = .version4_0
    guard let lib = try? device.makeLibrary(source: tensorKernels, options: opts) else { return nil }
    func run(_ name: String, elemA: Int, elemC: Int) -> Double? {
        guard let fn = lib.makeFunction(name: name), let pso = try? device.makeComputePipelineState(function: fn) else { return nil }
        guard let a = device.makeBuffer(length: n * n * elemA, options: .storageModePrivate), let b = device.makeBuffer(length: n * n * elemA, options: .storageModePrivate), let c = device.makeBuffer(length: n * n * elemC, options: .storageModePrivate) else { return nil }
        var nn = UInt32(n)
        var best = 0.0
        for _ in 0..<passes {
            let cb = queue.makeCommandBuffer()!
            let enc = cb.makeComputeCommandEncoder()!
            enc.setComputePipelineState(pso)
            enc.setBuffer(a, offset: 0, index: 0)
            enc.setBuffer(b, offset: 0, index: 1)
            enc.setBuffer(c, offset: 0, index: 2)
            enc.setBytes(&nn, length: 4, index: 3)
            enc.dispatchThreadgroups(MTLSize(width: n / 64, height: n / 128, depth: 1), threadsPerThreadgroup: MTLSize(width: 128, height: 1, depth: 1))
            enc.endEncoding()
            cb.commit()
            cb.waitUntilCompleted()
            if cb.status == .error { return nil }
            let s = cb.gpuEndTime - cb.gpuStartTime
            if s > 0 { best = max(best, 2.0 * Double(n) * Double(n) * Double(n) / s / 1e12) }
        }
        return best > 0 ? best : nil
    }
    guard let i8 = run("mm_i8", elemA: 1, elemC: 4), let f16 = run("mm_f16", elemA: 2, elemC: 4) else { return nil }
    return (i8, f16)
}

func bench() {
    let started = Date()
    print("device: \(device.name) (unified memory \(device.hasUnifiedMemory), working set \(device.recommendedMaxWorkingSetSize / (1 << 20)) MiB)")
    let bufferBytes = 1 << 30
    let bw = copyBandwidth(bufferBytes: bufferBytes, passes: 12)
    let n = 4096
    let fp32 = matmulTflops(n: n, half: false, passes: 5)
    let fp16 = matmulTflops(n: n, half: true, passes: 5)
    let tensor = tensorOps(n: n, passes: 8)
    var line: [String: Any] = [
        "device": device.name,
        "luid": String(format: "%016llx", device.registryID),
        "bandwidthGBs": bw.best,
        "bandwidthMedianGBs": bw.median,
        "bufferBytes": bufferBytes,
        "matmulN": n,
        "matmulTflopsFp32": fp32,
        "matmulTflopsFp16storage": fp16,
        "elapsedMs": Date().timeIntervalSince(started) * 1000
    ]
    if let t = tensor {
        line["matmulTopsInt8"] = t.int8Tops
        line["matmulTflopsFp16tensor"] = t.fp16Tflops
    }
    jsonLine(line)
}

// MARK: - loads

/// heavy: back-to-back matmuls with two command buffers in flight, the GPU never idle. light: one short kernel every 100 ms, a fraction of a frame's work.
func gpuLoad(seconds: Double, heavy: Bool) {
    let deadline = Date().addingTimeInterval(seconds)
    if heavy {
        let n = 2048
        let desc = MPSMatrixDescriptor(rows: n, columns: n, rowBytes: n * 4, dataType: .float32)
        func matrix() -> MPSMatrix { MPSMatrix(buffer: device.makeBuffer(length: n * n * 4, options: .storageModePrivate)!, descriptor: desc) }
        let (a, b, c) = (matrix(), matrix(), matrix())
        let mm = MPSMatrixMultiplication(device: device, transposeLeft: false, transposeRight: false, resultRows: n, resultColumns: n, interiorColumns: n, alpha: 1, beta: 0)
        // Two command buffers in flight; the semaphore is returned to its initial count before it
        // goes out of scope (libdispatch traps on a semaphore released below its initial value).
        let inFlight = DispatchSemaphore(value: 2)
        var last: MTLCommandBuffer? = nil
        while Date() < deadline {
            inFlight.wait()
            let cb = queue.makeCommandBuffer()!
            for _ in 0..<4 { mm.encode(commandBuffer: cb, leftMatrix: a, rightMatrix: b, resultMatrix: c) }
            cb.addCompletedHandler { _ in inFlight.signal() }
            cb.commit()
            last = cb
        }
        last?.waitUntilCompleted()
    } else {
        let pso = pipeline("spin")
        let n = 1 << 18
        let buf = device.makeBuffer(length: n * 4, options: .storageModePrivate)!
        var rounds: UInt32 = 64
        while Date() < deadline {
            let cb = queue.makeCommandBuffer()!
            let enc = cb.makeComputeCommandEncoder()!
            enc.setComputePipelineState(pso)
            enc.setBuffer(buf, offset: 0, index: 0)
            enc.setBytes(&rounds, length: 4, index: 1)
            enc.dispatchThreads(MTLSize(width: n, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: pso.maxTotalThreadsPerThreadgroup, height: 1, depth: 1))
            enc.endEncoding()
            cb.commit()
            cb.waitUntilCompleted()
            Thread.sleep(forTimeInterval: 0.1)
        }
    }
}

/// Every logical CPU runs the logistic-map FMA loop the Windows worker runs, so the cores boost as they would under a real all-core load.
func cpuLoad(seconds: Double) {
    let threads = ProcessInfo.processInfo.activeProcessorCount
    let deadline = Date().addingTimeInterval(seconds)
    let group = DispatchGroup()
    for t in 0..<threads {
        group.enter()
        Thread.detachNewThread {
            var x = 0.1 + Double(t) * 0.001
            var sink = 0.0
            while Date() < deadline {
                for _ in 0..<1_000_000 { x = 3.9 * x * (1 - x) }
                sink += x
            }
            if sink == -1 { print("never") }
            group.leave()
        }
    }
    group.wait()
}

/// Full-screen quads into an offscreen 4096 x 4096 target, as many per frame as fit in a few ms: pixels written per wall second after a 1 s warm-up.
func fillRate(seconds: Double) {
    let w = 4096, h = 4096
    let td = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: w, height: h, mipmapped: false)
    td.usage = [.renderTarget]
    td.storageMode = .private
    guard let target = device.makeTexture(descriptor: td) else { fail("No render target", code: 3) }
    let pd = MTLRenderPipelineDescriptor()
    pd.vertexFunction = library.makeFunction(name: "fullscreen")
    pd.fragmentFunction = library.makeFunction(name: "fill")
    pd.colorAttachments[0].pixelFormat = .bgra8Unorm
    let pso: MTLRenderPipelineState
    do { pso = try device.makeRenderPipelineState(descriptor: pd) } catch { fail("render pipeline: \(error)", code: 3) }
    let quadsPerFrame = 32
    let warm = Date().addingTimeInterval(1)
    let deadline = warm.addingTimeInterval(seconds)
    var frames = 0
    var pixels = 0.0
    var t: Float = 0
    var measuring = false
    var measuredFrom = Date()
    while true {
        let now = Date()
        if !measuring && now >= warm { measuring = true; measuredFrom = now; frames = 0; pixels = 0 }
        if now >= deadline { break }
        let cb = queue.makeCommandBuffer()!
        let rp = MTLRenderPassDescriptor()
        rp.colorAttachments[0].texture = target
        rp.colorAttachments[0].loadAction = .dontCare
        rp.colorAttachments[0].storeAction = .dontCare
        let enc = cb.makeRenderCommandEncoder(descriptor: rp)!
        enc.setRenderPipelineState(pso)
        enc.setFragmentBytes(&t, length: 4, index: 0)
        enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 6, instanceCount: quadsPerFrame)
        enc.endEncoding()
        cb.commit()
        cb.waitUntilCompleted()
        t += 0.01
        if measuring { frames += 1; pixels += Double(w * h * quadsPerFrame) }
    }
    let measured = Date().timeIntervalSince(measuredFrom)
    jsonLine(["pixelsPerSecond": pixels / measured, "seconds": measured, "frames": frames, "width": w, "height": h])
}

// MARK: - main

if flag("--info") {
    jsonLine(info())
} else if flag("--bench") {
    bench()
} else if let kind = value("--load") {
    let seconds = Double(value("--seconds") ?? "") ?? 0
    guard seconds > 0 else { fail("--seconds N is required", code: 2) }
    switch kind {
    case "heavy": gpuLoad(seconds: seconds, heavy: true)
    case "light": gpuLoad(seconds: seconds, heavy: false)
    case "cpu": cpuLoad(seconds: seconds)
    case "fillrate": fillRate(seconds: seconds)
    default: fail("unknown load kind \(kind)", code: 2)
    }
} else {
    fail("usage: strata-tune-mac-worker --info | --bench [--json] | --load <light|heavy|cpu|fillrate> --seconds N", code: 2)
}
