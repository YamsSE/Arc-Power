// Copyright (C) 2026 Arc Power contributors
// SPDX-License-Identifier: GPL-2.0-only
// Arc Power's adaptive unsharp mask. This is not Intel's legacy driver filter.
uniform float Sharpness <
    ui_type = "slider";
    ui_label = "Sharpening strength";
    ui_min = 0.0; ui_max = 1.0; ui_step = 0.01;
> = 0.5;

texture2D ArcPowerColor : COLOR;
sampler2D ArcPowerSampler
{
    Texture = ArcPowerColor;
    MinFilter = POINT; MagFilter = POINT; MipFilter = POINT;
    AddressU = CLAMP; AddressV = CLAMP;
};

void ArcPowerTriangle(uint id : SV_VertexID, out float4 position : SV_Position, out float2 uv : TEXCOORD)
{
    uv = float2((id << 1) & 2, id & 2);
    position = float4(uv * float2(2.0, -2.0) + float2(-1.0, 1.0), 0.0, 1.0);
}

float4 ArcPowerSharpenPixel(float4 position : SV_Position, float2 uv : TEXCOORD) : SV_Target
{
    const float2 pixel = float2(BUFFER_RCP_WIDTH, BUFFER_RCP_HEIGHT);
    float4 center = tex2D(ArcPowerSampler, uv);
    float3 north = tex2D(ArcPowerSampler, uv - float2(0.0, pixel.y)).rgb;
    float3 south = tex2D(ArcPowerSampler, uv + float2(0.0, pixel.y)).rgb;
    float3 west = tex2D(ArcPowerSampler, uv - float2(pixel.x, 0.0)).rgb;
    float3 east = tex2D(ArcPowerSampler, uv + float2(pixel.x, 0.0)).rgb;
    float3 low = min(center.rgb, min(min(north, south), min(west, east)));
    float3 high = max(center.rgb, max(max(north, south), max(west, east)));
    float3 blur = (center.rgb * 4.0 + north + south + west + east) * 0.125;
    // Limit overshoot to the local signal range, avoiding a fixed SDR clamp.
    float3 limit = (high - low) * 0.15;
    float3 sharpened = clamp(center.rgb + (center.rgb - blur) * (saturate(Sharpness) * 2.0), low - limit, high + limit);
    return float4(sharpened, center.a);
}

technique ArcPowerSharpen < ui_label = "Arc Power Sharpening"; >
{
    pass
    {
        VertexShader = ArcPowerTriangle;
        PixelShader = ArcPowerSharpenPixel;
    }
}
