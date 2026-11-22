// FidelityFX Super Resolution 1 EASU + RCAS shader entry points.
// Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.
// The MIT license is in this directory's LICENSE.txt.

#define A_GPU 1
#define A_HLSL 1
#define FSR_EASU_F 1
#define FSR_RCAS_F 1
#include "ffx_a.h"
#include "ffx_fsr1.h"

Texture2D<float4> image : register(t0);
SamplerState samLinearClamp : register(s0);

cbuffer Params : register(b0) {
  uint4 easuCon0;
  uint4 easuCon1;
  uint4 easuCon2;
  uint4 easuCon3;
  uint4 rcasCon;
  uint4 outputViewportOrigin;
};

struct VOut { float4 pos : SV_Position; float2 uv : TEXCOORD0; };

VOut VS(uint id : SV_VertexID) {
  VOut o;
  float2 p = float2((id << 1) & 2, id & 2);
  o.uv = p;
  o.pos = float4(p * float2(2, -2) + float2(-1, 1), 0, 1);
  return o;
}

AF4 FsrEasuRF(AF2 p) { return image.GatherRed(samLinearClamp, p, int2(0, 0)); }
AF4 FsrEasuGF(AF2 p) { return image.GatherGreen(samLinearClamp, p, int2(0, 0)); }
AF4 FsrEasuBF(AF2 p) { return image.GatherBlue(samLinearClamp, p, int2(0, 0)); }

float4 EasuPS(VOut i) : SV_Target {
  float3 color;
  FsrEasuF(color, uint2(i.pos.xy) - outputViewportOrigin.xy, easuCon0, easuCon1, easuCon2, easuCon3);
  return float4(color, 1.0);
}

AF4 FsrRcasLoadF(ASU2 p) { return image.Load(int3(p, 0)); }
void FsrRcasInputF(inout AF1 r, inout AF1 g, inout AF1 b) {}

float4 RcasPS(VOut i) : SV_Target {
  float r, g, b;
  FsrRcasF(r, g, b, uint2(i.pos.xy) - outputViewportOrigin.xy, rcasCon);
  return float4(r, g, b, 1.0);
}
