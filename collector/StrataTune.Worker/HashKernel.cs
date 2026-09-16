using ComputeSharp;

namespace StrataTune.Worker;

/// <summary>
/// One uint slot per thread. Each round folds the slot's previous value with (index, seed,
/// round) through lowbias32, an integer xorshift/multiply mix. Lanes never read each other,
/// so a corrupt result stays in the lane that produced it. Integer-only on purpose: float
/// shaders compile fast-math and would not reproduce bit-for-bit across drivers.
/// </summary>
[ThreadGroupSize(DefaultThreadGroupSizes.X)]
[GeneratedComputeShaderDescriptor]
public readonly partial struct HashKernel : IComputeShader
{
    private readonly ReadWriteBuffer<uint> slots;
    private readonly int offset;
    private readonly uint seed;
    private readonly uint firstRound;
    private readonly uint rounds;

    public HashKernel(ReadWriteBuffer<uint> slots, int offset, uint seed, uint firstRound, uint rounds)
    {
        this.slots = slots;
        this.offset = offset;
        this.seed = seed;
        this.firstRound = firstRound;
        this.rounds = rounds;
    }

    public void Execute()
    {
        int index = offset + ThreadIds.X;
        uint lane = (uint)index;
        uint x = slots[index];

        for (uint r = 0; r < rounds; r++)
        {
            uint z = x + lane * 0x9E3779B9u + seed + (firstRound + r) * 0xBF58476Du;
            z = (z ^ (z >> 16)) * 0x7FEB352Du;
            z = (z ^ (z >> 15)) * 0x846CA68Bu;
            x = z ^ (z >> 16);
        }

        slots[index] = x;
    }
}
