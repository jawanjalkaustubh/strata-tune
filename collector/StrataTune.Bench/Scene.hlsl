// The whole bench scene: a full-screen background pass and instanced cubes, neither with a
// vertex buffer (geometry comes from SV_VertexID / SV_InstanceID). VARIANT and SALT are
// defined per pipeline state in the shader-compile segment so every variant is new bytecode
// that the driver's disk cache has never seen.

cbuffer Frame : register(b0)
{
    row_major float4x4 viewProj;
    float time;
    uint instanceCount;
    uint gridSide;
    uint heavyIterations;
    float2 resolution;
    float2 padding;
};

cbuffer Draw : register(b1)
{
    uint firstInstance;
};

struct CubeVertex
{
    float4 position : SV_Position;
    float3 normal : NORMAL;
    float3 color : COLOR;
};

static const float3 Axis[3] = { float3(1, 0, 0), float3(0, 1, 0), float3(0, 0, 1) };
static const float2 Corner[6] = { float2(-1, -1), float2(1, -1), float2(-1, 1), float2(-1, 1), float2(1, -1), float2(1, 1) };

uint Hash(uint x)
{
    x ^= x >> 16;
    x *= 0x7FEB352Du;
    x ^= x >> 15;
    x *= 0x846CA68Bu;
    x ^= x >> 16;
    return x;
}

float3 Rotate(float3 v, float3 axis, float angle)
{
    float s = sin(angle);
    float c = cos(angle);
    return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1 - c);
}

CubeVertex CubeVS(uint vertexId : SV_VertexID, uint instanceId : SV_InstanceID)
{
    uint face = vertexId / 6;
    uint axis = face / 2;
    float3 n = Axis[axis] * ((face & 1) ? -1.0 : 1.0);
    float2 q = Corner[vertexId % 6];
    float3 local = n + Axis[(axis + 1) % 3] * q.x + Axis[(axis + 2) % 3] * q.y;

    uint index = instanceId + firstInstance;
    uint h = Hash(index);
    float3 spin = normalize(float3((h & 255) / 255.0 - 0.5, ((h >> 8) & 255) / 255.0 - 0.5, ((h >> 16) & 255) / 255.0 - 0.5) + 0.01);
    float angle = time * (0.4 + (h >> 24) / 255.0);
    float3 center = (float3(index % gridSide, (index / gridSide) % gridSide, index / (gridSide * gridSide)) - (gridSide - 1) * 0.5) * 4.0;

    CubeVertex o;
    o.position = mul(float4(Rotate(local, spin, angle) + center, 1), viewProj);
    o.normal = Rotate(n, spin, angle);
    o.color = float3((h >> 4) & 255, (h >> 12) & 255, (h >> 20) & 255) / 255.0 * 0.6 + 0.3;
    return o;
}

float4 CubePS(CubeVertex input) : SV_Target
{
    float3 light = normalize(float3(0.4, 0.8, -0.5));
    float3 color = input.color * (0.25 + 0.75 * saturate(dot(normalize(input.normal), light)));
#if VARIANT
    // Different unrolled length and constants per variant: distinct bytecode, distinct driver compile.
    uint h = SALT ^ ((uint)input.position.x * 0x9E3779B1u) ^ ((uint)input.position.y * 0x85EBCA6Bu);
    [unroll]
    for (uint i = 0; i < 24 + (VARIANT % 17); i++)
    {
        h ^= h >> 13;
        h *= 0x5BD1E995u + VARIANT;
        h ^= h >> 15;
    }
    color = lerp(color, float3(h & 255, (h >> 8) & 255, (h >> 16) & 255) / 255.0, 0.15);
#endif
    return float4(color, 1);
}

float4 BackgroundVS(uint vertexId : SV_VertexID) : SV_Position
{
    float2 uv = float2((vertexId << 1) & 2, vertexId & 2);
    return float4(uv * float2(2, -2) + float2(-1, 1), 1, 1);
}

float4 BackgroundPS(float4 position : SV_Position) : SV_Target
{
    float2 uv = position.xy / resolution;
    float3 color = lerp(float3(0.05, 0.06, 0.09), float3(0.10, 0.12, 0.18), uv.y);
    if (heavyIterations > 0)
    {
        // Eight dependent chains of bounded multiply-adds: the cost is proportional to the
        // iteration count and nothing here can be hoisted or unrolled away.
        float4 a = float4(uv, uv.x * uv.y, 1), b = a.yzwx, c = a.zwxy, d = a.wxyz;
        float4 e = a.wzyx, f = b.wzyx, g = c.wzyx, k = d.wzyx;
        [loop]
        for (uint i = 0; i < heavyIterations; i++)
        {
            a = a * 0.9999 + b * 0.0003;
            b = b * 0.9998 + c * 0.0003;
            c = c * 0.9997 + d * 0.0003;
            d = d * 0.9996 + e * 0.0003;
            e = e * 0.9995 + f * 0.0003;
            f = f * 0.9994 + g * 0.0003;
            g = g * 0.9993 + k * 0.0003;
            k = k * 0.9992 + a * 0.0003;
        }
        color += frac(a.x + b.y + c.z + d.w + e.x + f.y + g.z + k.w) * 0.02;
    }
    return float4(color, 1);
}
