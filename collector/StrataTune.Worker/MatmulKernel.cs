using ComputeSharp;

namespace StrataTune.Worker;

/// <summary>
/// C = A x B in fp32 on the shader cores, tiled the classic way: a 16 x 16 thread group
/// computes a 128 x 128 block of C, walking K in steps of 16 through two group-shared
/// tiles, and each thread keeps an 8 x 8 register tile so one shared load feeds many FMAs.
/// A is supplied column-major (the caller transposes it) so both tiles are k-major and
/// every shared access is a float4. The next tile's global loads are issued before the
/// current tile's FMAs so their latency hides under the arithmetic. A and B arrive as
/// uint4: one read is four floats or, with <see cref="halfStorage"/>, eight packed halves
/// unpacked by f16tof32: the storage is 16-bit, the arithmetic is float either way
/// (ComputeSharp 3.2.0 has no 16-bit element type, and cs_6_0 has no 16-bit math).
/// Timing-only, so fast-math float is fine.
/// </summary>
[ThreadGroupSize(16, 16, 1)]
[GeneratedComputeShaderDescriptor]
public readonly partial struct MatmulKernel : IComputeShader
{
    public const int Block = 128;
    public const int Threads = 16;
    private const int Step = 16;
    private const int GroupThreads = Threads * Threads;
    private const int Quads = Block / 4;

    // Tile [k][row quad] for A and [k][column quad] for B. The attribute sizes them; the
    // initialisers only satisfy the C# compiler and never run on the GPU.
    [GroupShared(Step * Quads)]
    private static Float4[] As = null!;

    [GroupShared(Step * Quads)]
    private static Float4[] Bs = null!;

    private readonly ReadOnlyBuffer<UInt4> a;
    private readonly ReadOnlyBuffer<UInt4> b;
    private readonly ReadWriteBuffer<Float4> c;
    private readonly int n;
    private readonly int firstRowBlock;
    private readonly bool halfStorage;

    public MatmulKernel(ReadOnlyBuffer<UInt4> a, ReadOnlyBuffer<UInt4> b, ReadWriteBuffer<Float4> c, int n, int firstRowBlock, bool halfStorage)
    {
        this.a = a;
        this.b = b;
        this.c = c;
        this.n = n;
        this.firstRowBlock = firstRowBlock;
        this.halfStorage = halfStorage;
    }

    public void Execute()
    {
        int tx = GroupIds.X;
        int ty = GroupIds.Y;
        int tid = ty * Threads + tx;
        int rowBase = (firstRowBlock + GridIds.Y) * Block;
        int colBase = GridIds.X * Block;

        // This thread owns rows rowBase + ty * 8 + i and the two column runs colBase + tx * 4
        // and colBase + 64 + tx * 4: consecutive threads read consecutive Bs vectors, so the
        // shared loads never bank-conflict.
        Float4 c00 = 0, c01 = 0, c10 = 0, c11 = 0, c20 = 0, c21 = 0, c30 = 0, c31 = 0;
        Float4 c40 = 0, c41 = 0, c50 = 0, c51 = 0, c60 = 0, c61 = 0, c70 = 0, c71 = 0;

        // A tile is 512 uint4 of floats (two per thread) or 256 of packed halves (one).
        UInt4 ra0 = Fetch(true, tid, rowBase, 0);
        UInt4 rb0 = Fetch(false, tid, colBase, 0);
        UInt4 ra1 = ra0;
        UInt4 rb1 = rb0;

        if (!halfStorage)
        {
            ra1 = Fetch(true, tid + GroupThreads, rowBase, 0);
            rb1 = Fetch(false, tid + GroupThreads, colBase, 0);
        }

        for (int k0 = 0; k0 < n; k0 += Step)
        {
            if (halfStorage)
            {
                StoreHalf(tid, ra0, rb0);
            }
            else
            {
                StoreFloat(tid, ra0, ra1, rb0, rb1);
            }

            Hlsl.GroupMemoryBarrierWithGroupSync();

            int next = k0 + Step;

            if (next < n)
            {
                ra0 = Fetch(true, tid, rowBase, next);
                rb0 = Fetch(false, tid, colBase, next);

                if (!halfStorage)
                {
                    ra1 = Fetch(true, tid + GroupThreads, rowBase, next);
                    rb1 = Fetch(false, tid + GroupThreads, colBase, next);
                }
            }

            for (int k = 0; k < Step; k++)
            {
                Float4 a0 = As[k * Quads + ty * 2];
                Float4 a1 = As[k * Quads + ty * 2 + 1];
                Float4 b0 = Bs[k * Quads + tx];
                Float4 b1 = Bs[k * Quads + Threads + tx];

                c00 += a0.X * b0; c01 += a0.X * b1;
                c10 += a0.Y * b0; c11 += a0.Y * b1;
                c20 += a0.Z * b0; c21 += a0.Z * b1;
                c30 += a0.W * b0; c31 += a0.W * b1;
                c40 += a1.X * b0; c41 += a1.X * b1;
                c50 += a1.Y * b0; c51 += a1.Y * b1;
                c60 += a1.Z * b0; c61 += a1.Z * b1;
                c70 += a1.W * b0; c71 += a1.W * b1;
            }

            Hlsl.GroupMemoryBarrierWithGroupSync();
        }

        int stride = n / 4;
        int col0 = colBase / 4 + tx;
        int col1 = col0 + Threads;
        int row = (rowBase + ty * 8) * stride;

        c[row + col0] = c00; c[row + col1] = c01; row += stride;
        c[row + col0] = c10; c[row + col1] = c11; row += stride;
        c[row + col0] = c20; c[row + col1] = c21; row += stride;
        c[row + col0] = c30; c[row + col1] = c31; row += stride;
        c[row + col0] = c40; c[row + col1] = c41; row += stride;
        c[row + col0] = c50; c[row + col1] = c51; row += stride;
        c[row + col0] = c60; c[row + col1] = c61; row += stride;
        c[row + col0] = c70; c[row + col1] = c71;
    }

    // Both inputs are k-major, so a tile element index maps the same way into either: one
    // k row of the tile is 32 uint4 of floats or 16 of packed halves, and consecutive
    // threads read consecutive elements.
    private UInt4 Fetch(bool fromA, int index, int origin, int k0)
    {
        int element;

        if (halfStorage)
        {
            element = (k0 + index / (Quads / 2)) * (n / 8) + origin / 8 + index % (Quads / 2);
        }
        else
        {
            element = (k0 + index / Quads) * (n / 4) + origin / 4 + index % Quads;
        }

        if (fromA)
        {
            return a[element];
        }

        return b[element];
    }

    // The tile index of a float element is its fetch index, so the store is a plain copy.
    private static void StoreFloat(int tid, UInt4 a0, UInt4 a1, UInt4 b0, UInt4 b1)
    {
        As[tid] = Hlsl.AsFloat(a0);
        As[tid + GroupThreads] = Hlsl.AsFloat(a1);
        Bs[tid] = Hlsl.AsFloat(b0);
        Bs[tid + GroupThreads] = Hlsl.AsFloat(b1);
    }

    // Eight halves per uint4, the even ones in the low 16 bits of each uint, so one element
    // is two consecutive quads of the tile.
    private static void StoreHalf(int tid, UInt4 a0, UInt4 b0)
    {
        int slot = tid / (Quads / 2) * Quads + tid % (Quads / 2) * 2;
        Float4 even = Hlsl.Float16ToFloat32(a0);
        Float4 odd = Hlsl.Float16ToFloat32(a0 >> 16);

        As[slot] = new Float4(even.X, odd.X, even.Y, odd.Y);
        As[slot + 1] = new Float4(even.Z, odd.Z, even.W, odd.W);

        even = Hlsl.Float16ToFloat32(b0);
        odd = Hlsl.Float16ToFloat32(b0 >> 16);

        Bs[slot] = new Float4(even.X, odd.X, even.Y, odd.Y);
        Bs[slot + 1] = new Float4(even.Z, odd.Z, even.W, odd.W);
    }
}
