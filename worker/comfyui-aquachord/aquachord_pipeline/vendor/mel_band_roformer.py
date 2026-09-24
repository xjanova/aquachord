# Vendored + trimmed for inference from lucidrains/BS-RoFormer (bs_roformer/mel_band_roformer.py)
# https://github.com/lucidrains/BS-RoFormer — MIT License, Copyright (c) 2023 Phil Wang
# (full license text: ../../THIRD_PARTY.md)
#
# โครงสร้าง/ชื่อพารามิเตอร์ตรงกับรุ่นที่ KimberleyJSN ใช้เทรน MelBandRoformer.ckpt (lucidrains ~v0.3.x)
# เพื่อให้ load_state_dict(strict=True) ได้ ตัดส่วนที่ inference ไม่ใช้ออก: loss หลายความละเอียด,
# beartype, rotary_embedding_torch (เขียน RoPE แบบ interleaved เองโดยเก็บ `freqs` เป็น Parameter ชื่อเดิม),
# flash-attn config เฉพาะ A100 (ใช้ F.scaled_dot_product_attention ให้ PyTorch เลือก kernel เอง)
from functools import partial

import numpy as np
import torch
import torch.nn.functional as F
from torch import nn


# ---------- RoPE (เทียบเท่า rotary_embedding_torch.RotaryEmbedding(dim) freqs_for='lang') ----------

class RotaryEmbedding(nn.Module):
    def __init__(self, dim, theta=10000):
        super().__init__()
        freqs = 1.0 / (theta ** (torch.arange(0, dim, 2)[: dim // 2].float() / dim))
        # ใน checkpoint มี key ".rotary_embed.freqs" (requires_grad=False) — คงชื่อไว้
        self.freqs = nn.Parameter(freqs, requires_grad=False)

    def rotate_queries_or_keys(self, t):
        # t: (b, h, n, d)
        n = t.shape[-2]
        seq = torch.arange(n, device=t.device, dtype=torch.float32)
        freqs = torch.einsum("n,f->nf", seq, self.freqs.float())
        freqs = freqs.repeat_interleave(2, dim=-1)  # '... n -> ... (n r)', r=2
        rot_dim = freqs.shape[-1]
        t_rot, t_pass = t[..., :rot_dim], t[..., rot_dim:]
        dtype = t.dtype
        t_rot = t_rot.float()
        x = t_rot.reshape(*t_rot.shape[:-1], -1, 2)
        x1, x2 = x.unbind(dim=-1)
        rotated = torch.stack((-x2, x1), dim=-1).reshape(t_rot.shape)
        t_rot = t_rot * freqs.cos() + rotated * freqs.sin()
        return torch.cat((t_rot.to(dtype), t_pass), dim=-1)


# ---------- building blocks ----------

class RMSNorm(nn.Module):
    def __init__(self, dim):
        super().__init__()
        self.scale = dim ** 0.5
        self.gamma = nn.Parameter(torch.ones(dim))

    def forward(self, x):
        return F.normalize(x, dim=-1) * self.scale * self.gamma


class FeedForward(nn.Module):
    def __init__(self, dim, mult=4, dropout=0.0):
        super().__init__()
        dim_inner = int(dim * mult)
        self.net = nn.Sequential(
            RMSNorm(dim),
            nn.Linear(dim, dim_inner),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(dim_inner, dim),
            nn.Dropout(dropout),
        )

    def forward(self, x):
        return self.net(x)


class Attention(nn.Module):
    def __init__(self, dim, heads=8, dim_head=64, dropout=0.0, rotary_embed=None):
        super().__init__()
        self.heads = heads
        dim_inner = heads * dim_head
        self.rotary_embed = rotary_embed
        self.norm = RMSNorm(dim)
        self.to_qkv = nn.Linear(dim, dim_inner * 3, bias=False)
        self.to_gates = nn.Linear(dim, heads)
        self.to_out = nn.Sequential(nn.Linear(dim_inner, dim, bias=False), nn.Dropout(dropout))

    def forward(self, x):
        x = self.norm(x)
        b, n, _ = x.shape
        qkv = self.to_qkv(x).reshape(b, n, 3, self.heads, -1).permute(2, 0, 3, 1, 4)
        q, k, v = qkv[0], qkv[1], qkv[2]  # (b, h, n, d)
        if self.rotary_embed is not None:
            q = self.rotary_embed.rotate_queries_or_keys(q)
            k = self.rotary_embed.rotate_queries_or_keys(k)
        out = F.scaled_dot_product_attention(q, k, v)
        gates = self.to_gates(x)  # (b, n, h)
        out = out * gates.permute(0, 2, 1).unsqueeze(-1).sigmoid()
        out = out.permute(0, 2, 1, 3).reshape(b, n, -1)
        return self.to_out(out)


class Transformer(nn.Module):
    def __init__(self, *, dim, depth, dim_head=64, heads=8, attn_dropout=0.0, ff_dropout=0.0,
                 ff_mult=4, norm_output=True, rotary_embed=None):
        super().__init__()
        self.layers = nn.ModuleList([])
        for _ in range(depth):
            self.layers.append(nn.ModuleList([
                Attention(dim=dim, dim_head=dim_head, heads=heads, dropout=attn_dropout, rotary_embed=rotary_embed),
                FeedForward(dim=dim, mult=ff_mult, dropout=ff_dropout),
            ]))
        self.norm = RMSNorm(dim) if norm_output else nn.Identity()

    def forward(self, x):
        for attn, ff in self.layers:
            x = attn(x) + x
            x = ff(x) + x
        return self.norm(x)


class BandSplit(nn.Module):
    def __init__(self, dim, dim_inputs):
        super().__init__()
        self.dim_inputs = tuple(dim_inputs)
        self.to_features = nn.ModuleList([nn.Sequential(RMSNorm(d), nn.Linear(d, dim)) for d in self.dim_inputs])

    def forward(self, x):
        xs = x.split(self.dim_inputs, dim=-1)
        return torch.stack([f(s) for s, f in zip(xs, self.to_features)], dim=-2)


def MLP(dim_in, dim_out, dim_hidden=None, depth=1, activation=nn.Tanh):
    dim_hidden = dim_hidden or dim_in
    dims = (dim_in, *((dim_hidden,) * depth), dim_out)
    net = []
    for ind, (a, b) in enumerate(zip(dims[:-1], dims[1:])):
        net.append(nn.Linear(a, b))
        if ind != len(dims) - 2:
            net.append(activation())
    return nn.Sequential(*net)


class MaskEstimator(nn.Module):
    def __init__(self, dim, dim_inputs, depth, mlp_expansion_factor=4):
        super().__init__()
        self.dim_inputs = tuple(dim_inputs)
        dim_hidden = dim * mlp_expansion_factor
        self.to_freqs = nn.ModuleList([
            nn.Sequential(MLP(dim, d * 2, dim_hidden=dim_hidden, depth=depth), nn.GLU(dim=-1))
            for d in self.dim_inputs
        ])

    def forward(self, x):
        xs = x.unbind(dim=-2)
        return torch.cat([mlp(bf) for bf, mlp in zip(xs, self.to_freqs)], dim=-1)


def _mel_filter_bank(sr, n_fft, n_mels):
    """librosa.filters.mel (slaney) — ใช้แค่ว่า bin ไหน > 0 จึงไม่ต้องเป๊ะระดับบิต"""
    import librosa
    return librosa.filters.mel(sr=sr, n_fft=n_fft, n_mels=n_mels)


class MelBandRoformer(nn.Module):
    def __init__(self, dim, *, depth, stereo=False, num_stems=1, time_transformer_depth=2,
                 freq_transformer_depth=2, num_bands=60, dim_head=64, heads=8, attn_dropout=0.1,
                 ff_dropout=0.1, dim_freqs_in=1025, sample_rate=44100, stft_n_fft=2048,
                 stft_hop_length=512, stft_win_length=2048, stft_normalized=False,
                 mask_estimator_depth=1, **_unused):
        super().__init__()
        self.stereo = stereo
        self.audio_channels = 2 if stereo else 1
        self.num_stems = num_stems
        self.layers = nn.ModuleList([])
        tkw = dict(dim=dim, heads=heads, dim_head=dim_head, attn_dropout=attn_dropout, ff_dropout=ff_dropout)
        time_rotary_embed = RotaryEmbedding(dim=dim_head)
        freq_rotary_embed = RotaryEmbedding(dim=dim_head)
        for _ in range(depth):
            self.layers.append(nn.ModuleList([
                Transformer(depth=time_transformer_depth, rotary_embed=time_rotary_embed, **tkw),
                Transformer(depth=freq_transformer_depth, rotary_embed=freq_rotary_embed, **tkw),
            ]))

        self.stft_win_length = stft_win_length
        self.stft_kwargs = dict(n_fft=stft_n_fft, hop_length=stft_hop_length, win_length=stft_win_length,
                                normalized=stft_normalized)
        freqs = stft_n_fft // 2 + 1

        mel = torch.from_numpy(np.asarray(_mel_filter_bank(sample_rate, stft_n_fft, num_bands)))
        mel[0][0] = 1.0
        mel[-1, -1] = 1.0
        freqs_per_band = mel > 0
        if not freqs_per_band.any(dim=0).all():
            raise ValueError("mel bands do not cover all frequencies")

        repeated = torch.arange(freqs).unsqueeze(0).expand(num_bands, freqs)
        freq_indices = repeated[freqs_per_band]
        if stereo:
            freq_indices = freq_indices.unsqueeze(-1).expand(-1, 2) * 2 + torch.arange(2)
            freq_indices = freq_indices.reshape(-1)
        self.register_buffer("freq_indices", freq_indices, persistent=False)
        self.register_buffer("freqs_per_band", freqs_per_band, persistent=False)
        num_freqs_per_band = freqs_per_band.sum(dim=1)
        num_bands_per_freq = freqs_per_band.sum(dim=0)
        self.register_buffer("num_freqs_per_band", num_freqs_per_band, persistent=False)
        self.register_buffer("num_bands_per_freq", num_bands_per_freq, persistent=False)

        dims_c = tuple(2 * int(f) * self.audio_channels for f in num_freqs_per_band.tolist())
        self.band_split = BandSplit(dim=dim, dim_inputs=dims_c)
        self.mask_estimators = nn.ModuleList([
            MaskEstimator(dim=dim, dim_inputs=dims_c, depth=mask_estimator_depth) for _ in range(num_stems)
        ])

    def forward(self, raw_audio):
        """raw_audio: (b, s, t) float32 → (b, s, t) (num_stems == 1)"""
        device = raw_audio.device
        if raw_audio.ndim == 2:
            raw_audio = raw_audio.unsqueeze(1)
        batch, channels, length = raw_audio.shape
        if (self.stereo and channels != 2) or (not self.stereo and channels != 1):
            raise ValueError("channel count does not match model")

        flat = raw_audio.reshape(batch * channels, length)
        window = torch.hann_window(self.stft_win_length, device=device)
        stft = torch.stft(flat.float(), **self.stft_kwargs, window=window, return_complex=True)
        stft = torch.view_as_real(stft)  # (b*s, f, t, 2)
        n_f, n_t = stft.shape[1], stft.shape[2]
        stft = stft.reshape(batch, channels, n_f, n_t, 2)
        # 'b s f t c -> b (f s) t c'
        stft = stft.permute(0, 2, 1, 3, 4).reshape(batch, n_f * channels, n_t, 2)

        x = stft[:, self.freq_indices]  # (b, F', t, 2)
        x = x.permute(0, 2, 1, 3).reshape(batch, n_t, -1)  # 'b f t c -> b t (f c)'
        x = self.band_split(x)  # (b, t, bands, d) — น้ำหนัก fp32 เสมอ, ความแม่นต่ำใช้ autocast จากภายนอก

        for time_tf, freq_tf in self.layers:
            b_, t_, f_, d_ = x.shape
            x = x.permute(0, 2, 1, 3).reshape(b_ * f_, t_, d_)
            x = time_tf(x)
            x = x.reshape(b_, f_, t_, d_).permute(0, 2, 1, 3).reshape(b_ * t_, f_, d_)
            x = freq_tf(x)
            x = x.reshape(b_, t_, f_, d_)

        num_stems = len(self.mask_estimators)
        masks = torch.stack([fn(x) for fn in self.mask_estimators], dim=1)  # (b, n, t, F'*2)
        masks = masks.float().reshape(batch, num_stems, n_t, -1, 2).permute(0, 1, 3, 2, 4)  # b n f t c

        stft_c = torch.view_as_complex(stft.contiguous()).unsqueeze(1)  # (b, 1, f*s, t)
        masks_c = torch.view_as_complex(masks.contiguous())

        idx = self.freq_indices.view(1, 1, -1, 1).expand(batch, num_stems, -1, n_t)
        masks_summed = torch.zeros(batch, num_stems, stft_c.shape[2], n_t, dtype=masks_c.dtype, device=device)
        masks_summed.scatter_add_(2, idx, masks_c)
        denom = self.num_bands_per_freq.repeat_interleave(channels).view(1, 1, -1, 1)
        masks_avg = masks_summed / denom.clamp(min=1e-8)

        out = stft_c * masks_avg  # (b, n, f*s, t)
        out = out.reshape(batch, num_stems, n_f, channels, n_t).permute(0, 1, 3, 2, 4)
        out = out.reshape(batch * num_stems * channels, n_f, n_t)
        recon = torch.istft(out, **self.stft_kwargs, window=window, return_complex=False, length=length)
        recon = recon.reshape(batch, num_stems, channels, -1)
        if num_stems == 1:
            recon = recon[:, 0]
        return recon


# config ของ KimberleyJSN/Mel-Band-Roformer-Vocal-Model configs/config_vocals_mel_band_roformer.yaml
KIM_VOCALS_CONFIG = dict(
    dim=384, depth=6, stereo=True, num_stems=1, time_transformer_depth=1, freq_transformer_depth=1,
    num_bands=60, dim_head=64, heads=8, attn_dropout=0.0, ff_dropout=0.0, dim_freqs_in=1025,
    sample_rate=44100, stft_n_fft=2048, stft_hop_length=441, stft_win_length=2048, stft_normalized=False,
    mask_estimator_depth=2,
)
KIM_SAMPLE_RATE = 44100
KIM_CHUNK_SIZE = 352800  # 8 วินาที = ความยาวที่ใช้เทรน
