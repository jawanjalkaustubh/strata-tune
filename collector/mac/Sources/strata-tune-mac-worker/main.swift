// strata-tune-mac-worker: the macOS twin of StrataTune.Worker and StrataTune.Bench.
//
//   --info --json                          the Metal device: name, unified memory, working-set size
//   --bench --json                         stream-copy bandwidth and matmul throughput (one JSON line last)
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
func warn(_ message: String) {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
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
/// Compiled on first use: --info (read by the collector at every launch) and the MPS-only paths never need it.
var compiledLibrary: MTLLibrary? = nil
func library() -> MTLLibrary {
    if let l = compiledLibrary { return l }
    do { compiledLibrary = try device.makeLibrary(source: kernels, options: nil) } catch { fail("Metal compile failed: \(error)", code: 3) }
    return compiledLibrary!
}
func pipeline(_ name: String) -> MTLComputePipelineState {
    do { return try device.makeComputePipelineState(function: library().makeFunction(name: name)!) } catch { fail("pipeline \(name): \(error)", code: 3) }
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

// MARK: - data

/// A private buffer filled once through a shared staging copy: the kernels read real, non-zero data
/// (a buffer never written reads as zeros, which a GPU multiplies with less switching, so less power
/// and a flattering clock) from the same private storage the timed runs use.
func filledBuffer(length: Int, fill: (UnsafeMutableRawPointer) -> Void) -> MTLBuffer {
    guard let staging = device.makeBuffer(length: length, options: .storageModeShared), let buffer = device.makeBuffer(length: length, options: .storageModePrivate) else { fail("Could not allocate \(length) bytes", code: 3) }
    fill(staging.contents())
    let cb = queue.makeCommandBuffer()!
    let blit = cb.makeBlitCommandEncoder()!
    blit.copy(from: staging, sourceOffset: 0, to: buffer, destinationOffset: 0, size: length)
    blit.endEncoding()
    cb.commit()
    cb.waitUntilCompleted()
    return buffer
}

func privateBuffer(length: Int) -> MTLBuffer {
    guard let b = device.makeBuffer(length: length, options: .storageModePrivate) else { fail("Could not allocate \(length) bytes", code: 3) }
    return b
}

/// `count` bytes at `offset` of a private buffer, blitted out to read on the CPU.
func readBack(_ buffer: MTLBuffer, offset: Int, count: Int) -> [UInt8] {
    let staging = device.makeBuffer(length: count, options: .storageModeShared)!
    let cb = queue.makeCommandBuffer()!
    let blit = cb.makeBlitCommandEncoder()!
    blit.copy(from: buffer, sourceOffset: offset, to: staging, destinationOffset: 0, size: count)
    blit.endEncoding()
    cb.commit()
    cb.waitUntilCompleted()
    let p = staging.contents().bindMemory(to: UInt8.self, capacity: count)
    return Array(UnsafeBufferPointer(start: p, count: count))
}

/// The matrix inputs: whole numbers from -2 to 2, exact in int8, fp16 and fp32, cycling so that a
/// row of A against a column of B sums to thousands rather than cancelling to nothing, and the sum is
/// exact in an int32 or float result. One output element is then checked against the CPU's sum.
func valueA(_ row: Int, _ col: Int) -> Int { (row * 7 + col * 3) % 5 - 2 }
func valueB(_ row: Int, _ col: Int) -> Int { (row * 3 + col) % 5 - 2 }
func expected(n: Int, row: Int, col: Int, scale: Double) -> Double {
    var sum = 0
    for k in 0..<n { sum += valueA(row, k) * valueB(k, col) }
    return Double(sum) * scale
}
/// The element every matmul checks: off the diagonal and away from the first tile.
func checkPoint(_ n: Int) -> (row: Int, col: Int) { (n / 2 + 17, n / 3 + 5) }

enum Element { case int8, fp16, fp32 }
func fillMatrix(_ n: Int, _ type: Element, _ value: @escaping (Int, Int) -> Int, scale: Float) -> MTLBuffer {
    let size = type == .int8 ? 1 : type == .fp16 ? 2 : 4
    return filledBuffer(length: n * n * size) { p in
        for r in 0..<n {
            for c in 0..<n {
                let v = Float(value(r, c)) * scale
                switch type {
                case .int8: p.storeBytes(of: Int8(v), toByteOffset: r * n + c, as: Int8.self)
                case .fp16: p.storeBytes(of: Float16(v), toByteOffset: (r * n + c) * 2, as: Float16.self)
                case .fp32: p.storeBytes(of: v, toByteOffset: (r * n + c) * 4, as: Float.self)
                }
            }
        }
    }
}

/// One element of an n x n result buffer, as a Double.
func resultAt(_ c: MTLBuffer, n: Int, type: String, row: Int, col: Int) -> Double {
    let size = type == "half" ? 2 : 4
    let bytes = readBack(c, offset: (row * n + col) * size, count: size)
    return bytes.withUnsafeBytes { raw -> Double in
        switch type {
        case "half": return Double(raw.load(as: Float16.self))
        case "int32": return Double(raw.load(as: Int32.self))
        default: return Double(raw.load(as: Float.self))
        }
    }
}

// MARK: - timing

/// The GPU time of one command buffer holding `reps` of the op.
func gpuSeconds(_ reps: Int, _ encode: (MTLCommandBuffer) -> Void) -> Double {
    let cb = queue.makeCommandBuffer()!
    for _ in 0..<reps { encode(cb) }
    cb.commit()
    cb.waitUntilCompleted()
    return cb.status == .error ? -1 : cb.gpuEndTime - cb.gpuStartTime
}

/// Throughput of an op the way a GPU should be timed: about a second of warm-up (clocks up, caches
/// and pipelines built, the op count per buffer re-sized as the clock rises), then five command
/// buffers each repeating the op for about 100 ms, and the median of their rates. `work` is one op's
/// flops or bytes; nil when the GPU reported an error.
func throughput(work: Double, warmSeconds: Double = 1.0, bufferSeconds: Double = 0.1, _ encode: (MTLCommandBuffer) -> Void) -> Double? {
    var reps = 1
    let warmUntil = Date().addingTimeInterval(warmSeconds)
    repeat {
        let s = gpuSeconds(reps, encode)
        if s < 0 { return nil }
        reps = max(1, Int((Double(reps) * bufferSeconds / max(s, 1e-6)).rounded()))
    } while Date() < warmUntil
    var rates: [Double] = []
    for _ in 0..<5 {
        let s = gpuSeconds(reps, encode)
        if s < 0 { return nil }
        if s > 0 { rates.append(work * Double(reps) / s) }
    }
    rates.sort()
    return rates.isEmpty ? nil : rates[rates.count / 2]
}

/// One output element against the CPU's sum; false (and a line on stderr) when the GPU's result is wrong.
func verify(_ label: String, _ c: MTLBuffer, n: Int, type: String, scale: Double, tolerance: Double) -> Bool {
    let (row, col) = checkPoint(n)
    let want = expected(n: n, row: row, col: col, scale: scale)
    let got = resultAt(c, n: n, type: type, row: row, col: col)
    let ok = abs(got - want) <= tolerance * max(1, abs(want))
    if !ok { warn("\(label): C[\(row)][\(col)] = \(got), expected \(want); the figure is left out") }
    return ok
}

// MARK: - bench

/// STREAM-style copy: every element read once and written once, so bytes moved = 2 x buffer. A warm-up
/// pass, then best and median of the passes (a 1 GiB pass is a few milliseconds of GPU time on its own).
func copyBandwidth(bufferBytes: Int, passes: Int) -> (best: Double, median: Double) {
    let pso = pipeline("copyk")
    let n = bufferBytes / 16
    let a = filledBuffer(length: n * 16) { p in
        let f = p.bindMemory(to: Float.self, capacity: n * 4)
        for i in 0..<(n * 4) { f[i] = Float(i & 1023) + 0.5 }
    }
    let b = privateBuffer(length: n * 16)
    let encode = { (cb: MTLCommandBuffer) in
        let enc = cb.makeComputeCommandEncoder()!
        enc.setComputePipelineState(pso)
        enc.setBuffer(a, offset: 0, index: 0)
        enc.setBuffer(b, offset: 0, index: 1)
        enc.dispatchThreads(MTLSize(width: n, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: pso.maxTotalThreadsPerThreadgroup, height: 1, depth: 1))
        enc.endEncoding()
    }
    let warmUntil = Date().addingTimeInterval(0.5)
    while Date() < warmUntil { _ = gpuSeconds(1, encode) }
    var rates: [Double] = []
    for _ in 0..<passes {
        let s = gpuSeconds(1, encode)
        if s > 0 { rates.append(Double(2 * n * 16) / s / 1e9) }
    }
    rates.sort()
    return (rates.last ?? 0, rates.isEmpty ? 0 : rates[rates.count / 2])
}

/// MPS matmul of two N x N matrices: 2N^3 flops per op. At fp16 MPS does the maths in half precision
/// (on the M5 through the GPU's matrix units: about 4x its fp32), not half storage with float maths
/// as the Windows worker's fp16storage figure is, so the Mac prints it under its own key.
func matmulTflops(n: Int, half: Bool) -> (tflops: Double, verified: Bool)? {
    let bytes = half ? 2 : 4
    let desc = MPSMatrixDescriptor(rows: n, columns: n, rowBytes: n * bytes, dataType: half ? .float16 : .float32)
    let type: Element = half ? .fp16 : .fp32
    // fp32 in half steps (products in quarter steps: every partial sum exact, far below 2^24); fp16 in
    // whole numbers, the result then within a half-precision rounding of the exact sum.
    let scaleA: Float = half ? 1 : 0.5
    let scaleB: Float = half ? 1 : 0.5
    let a = MPSMatrix(buffer: fillMatrix(n, type, valueA, scale: scaleA), descriptor: desc)
    let b = MPSMatrix(buffer: fillMatrix(n, type, valueB, scale: scaleB), descriptor: desc)
    let cBuffer = privateBuffer(length: n * n * bytes)
    let c = MPSMatrix(buffer: cBuffer, descriptor: desc)
    let mm = MPSMatrixMultiplication(device: device, transposeLeft: false, transposeRight: false, resultRows: n, resultColumns: n, interiorColumns: n, alpha: 1, beta: 0)
    guard let rate = throughput(work: 2.0 * Double(n) * Double(n) * Double(n), { cb in mm.encode(commandBuffer: cb, leftMatrix: a, rightMatrix: b, resultMatrix: c) }) else { return nil }
    let ok = verify(half ? "fp16 matmul" : "fp32 matmul", cBuffer, n: n, type: half ? "half" : "float", scale: Double(scaleA * scaleB), tolerance: 1e-3)
    return (rate / 1e12, ok)
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

func tensorOps(n: Int) -> (int8Tops: Double?, fp16Tflops: Double?)? {
    guard #available(macOS 26.0, *) else { return nil }
    let opts = MTLCompileOptions()
    opts.languageVersion = .version4_0
    guard let lib = try? device.makeLibrary(source: tensorKernels, options: opts) else { return nil }
    func run(_ name: String, _ type: Element, resultType: String) -> Double? {
        guard let fn = lib.makeFunction(name: name), let pso = try? device.makeComputePipelineState(function: fn) else { return nil }
        let a = fillMatrix(n, type, valueA, scale: 1)
        let b = fillMatrix(n, type, valueB, scale: 1)
        let c = privateBuffer(length: n * n * 4)
        var nn = UInt32(n)
        let rate = throughput(work: 2.0 * Double(n) * Double(n) * Double(n)) { cb in
            let enc = cb.makeComputeCommandEncoder()!
            enc.setComputePipelineState(pso)
            enc.setBuffer(a, offset: 0, index: 0)
            enc.setBuffer(b, offset: 0, index: 1)
            enc.setBuffer(c, offset: 0, index: 2)
            enc.setBytes(&nn, length: 4, index: 3)
            enc.dispatchThreadgroups(MTLSize(width: n / 64, height: n / 128, depth: 1), threadsPerThreadgroup: MTLSize(width: 128, height: 1, depth: 1))
            enc.endEncoding()
        }
        guard let r = rate, verify(name, c, n: n, type: resultType, scale: 1, tolerance: resultType == "int32" ? 0 : 1e-3) else { return nil }
        return r / 1e12
    }
    let i8 = run("mm_i8", .int8, resultType: "int32")
    let f16 = run("mm_f16", .fp16, resultType: "float")
    return i8 == nil && f16 == nil ? nil : (i8, f16)
}

func bench() {
    let started = Date()
    print("device: \(device.name) (unified memory \(device.hasUnifiedMemory), working set \(device.recommendedMaxWorkingSetSize / (1 << 20)) MiB)")
    let bufferBytes = 1 << 30
    let bw = copyBandwidth(bufferBytes: bufferBytes, passes: 12)
    let n = 4096
    guard let fp32 = matmulTflops(n: n, half: false) else { fail("The fp32 matmul failed on the GPU", code: 3) }
    let fp16 = matmulTflops(n: n, half: true)
    let tensor = tensorOps(n: n)
    var line: [String: Any] = [
        "device": device.name,
        "luid": String(format: "%016llx", device.registryID),
        "bandwidthGBs": bw.best,
        "bandwidthMedianGBs": bw.median,
        "bufferBytes": bufferBytes,
        "matmulN": n,
        "matmulTflopsFp32": fp32.tflops,
        "matmulVerified": fp32.verified && (fp16?.verified ?? true),
        "elapsedMs": Date().timeIntervalSince(started) * 1000
    ]
    if let h = fp16, h.verified { line["matmulTflopsFp16mps"] = h.tflops }
    if let t = tensor {
        if let v = t.int8Tops { line["matmulTopsInt8"] = v }
        if let v = t.fp16Tflops { line["matmulTflopsFp16tensor"] = v }
    }
    jsonLine(line)
}

// MARK: - loads

/// heavy: back-to-back matmuls on non-zero data with two command buffers in flight, the GPU never idle. light: one short kernel every 100 ms, a fraction of a frame's work.
func gpuLoad(seconds: Double, heavy: Bool) {
    let deadline = Date().addingTimeInterval(seconds)
    if heavy {
        let n = 2048
        let desc = MPSMatrixDescriptor(rows: n, columns: n, rowBytes: n * 4, dataType: .float32)
        let a = MPSMatrix(buffer: fillMatrix(n, .fp32, valueA, scale: 0.5), descriptor: desc)
        let b = MPSMatrix(buffer: fillMatrix(n, .fp32, valueB, scale: 0.5), descriptor: desc)
        let c = MPSMatrix(buffer: privateBuffer(length: n * n * 4), descriptor: desc)
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
        let buf = filledBuffer(length: n * 4) { p in
            let f = p.bindMemory(to: Float.self, capacity: n)
            for i in 0..<n { f[i] = Float(i % 997) / 997 }
        }
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

/// Every logical CPU runs eight independent SIMD4<Float> chains of the logistic map the Windows worker
/// runs (x = 3.9 x (1 - x): one fused multiply-add and a multiply per step) at user-initiated QoS.
/// Eight chains of four lanes are enough independent work to keep the vector units busy, so the cores
/// draw and boost as they would under a real all-core load; one dependent scalar chain waits on its
/// own latency and idles most of the core. The map stays inside (0, 1) and never settles, so the
/// operands keep changing like real data.
func cpuLoad(seconds: Double) {
    let threads = ProcessInfo.processInfo.activeProcessorCount
    let deadline = Date().addingTimeInterval(seconds)
    let group = DispatchGroup()
    for t in 0..<threads {
        group.enter()
        let worker = Thread {
            let r = SIMD4<Float>(repeating: 3.9)
            let seed = Float(t) * 1e-3
            var x0 = SIMD4<Float>(0.11, 0.23, 0.37, 0.41) + seed, x1 = x0 + 0.011, x2 = x0 + 0.022, x3 = x0 + 0.033
            var x4 = x0 + 0.044, x5 = x0 + 0.055, x6 = x0 + 0.066, x7 = x0 + 0.077
            while Date() < deadline {
                for _ in 0..<100_000 {
                    x0 = x0.addingProduct(-x0, x0) * r; x1 = x1.addingProduct(-x1, x1) * r; x2 = x2.addingProduct(-x2, x2) * r; x3 = x3.addingProduct(-x3, x3) * r
                    x4 = x4.addingProduct(-x4, x4) * r; x5 = x5.addingProduct(-x5, x5) * r; x6 = x6.addingProduct(-x6, x6) * r; x7 = x7.addingProduct(-x7, x7) * r
                }
            }
            let sum = (x0 + x1 + x2 + x3 + x4 + x5 + x6 + x7).sum()
            if sum == -1 { print("never") }
            group.leave()
        }
        worker.qualityOfService = .userInitiated
        worker.start()
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
    pd.vertexFunction = library().makeFunction(name: "fullscreen")
    pd.fragmentFunction = library().makeFunction(name: "fill")
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
