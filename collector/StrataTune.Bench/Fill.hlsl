// The fill-rate pass: one oversized triangle that covers the whole target (the usual way to
// draw a full-screen quad without a seam) and a pixel shader that writes a constant. There
// is nothing for the shader units to do, so the pixels per second the pass achieves is the
// raster back end's write rate: one 32-bit pixel per ROP per clock at best.

cbuffer Quad : register(b0)
{
    float4 colour;
};

float4 FillVS(uint vertexId : SV_VertexID) : SV_Position
{
    float2 uv = float2((vertexId << 1) & 2, vertexId & 2);
    return float4(uv * float2(2, -2) + float2(-1, 1), 0, 1);
}

float4 FillPS() : SV_Target
{
    return colour;
}
