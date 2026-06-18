/**
 * The cinematic scene. One canvas, composited each frame from the World model:
 *
 *   ┌──────────────── header (title · game clock · REC) ────────────────┐
 *   │ market price charts   │  daemon arena (animated)  │  TVL / stats  │
 *   │ (small multiples)     │  nodes pulse + trade      │  growing bar  │
 *   ├───────────────────────┴───────────────────────────┴──────────────┤
 *   │ billboard ticker — agent trash-talk, spicy ones get hero glow     │
 *   └───────────────────────────────────────────────────────────────────┘
 *
 * Plus floating "much wow" toasts for market_created / resolved / whale trades,
 * a title card on intro and a finale card with the winner at the end.
 */
import type { Clock } from '../engine/clock.js';
import type { World, MarketState } from '../engine/world.js';
import { clamp, easeOut, elapsed, lerp, signed, usd } from '../util.js';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Toast {
  text: string;
  sub: string;
  color: string;
  born: number; // real seconds
  life: number;
}

const PRODUCT_NAME = 'DAEMON HALL';
const VOID = '#0a0a0f';
const HAIR = '#24242e';
const SILVER = '#d7d7df';
const BONE = '#e7e3d9';
const VIOLET = '#8b7bff';
const EMBER = '#ff6a2c';
const FONT_DISPLAY = 'Chakra Petch, system-ui, sans-serif';
const FONT_MONO = 'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace';
const MARKET_STROKES = [SILVER, '#c8c7d3', '#b7b4d9', VIOLET, '#a7a1d8', '#cfcfd7', '#bcbcc6', '#ececf2'];

export class Scene {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private W = 0;
  private H = 0;
  private realT = 0; // accumulated real seconds for animation phase
  private toasts: Toast[] = [];
  private seenCreated = new Set<string>();
  private seenResolved = new Set<string>();
  private seenWhales = new Set<string>();
  private portraitVideos = new Map<string, HTMLVideoElement>();
  private portraitImages = new Map<string, HTMLImageElement>();
  /** phyllotaxis unit offsets per player index */
  private spiral: { x: number; y: number }[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private world: World,
    private clock: Clock,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    this.ctx = ctx;
    this.buildSpiral(world.bundle.players.length);
    this.loadPortraitMedia();
    this.resize();
  }

  private loadPortraitMedia() {
    for (const p of this.world.bundle.players) {
      if (!p.videoSrc) continue;
      const img = new Image();
      img.src = p.videoSrc.replace('/videos/', '/').replace(/\.mp4$/, '.webp');
      img.crossOrigin = 'anonymous';
      this.portraitImages.set(p.agentId, img);

      const v = document.createElement('video');
      v.src = p.videoSrc;
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.autoplay = true;
      v.crossOrigin = 'anonymous';
      const seamless = () => {
        if (Number.isFinite(v.duration) && v.duration > 0 && v.currentTime > v.duration - 0.08) v.currentTime = 0.03;
      };
      v.addEventListener('timeupdate', seamless);
      v.addEventListener('ended', () => {
        v.currentTime = 0.03;
        v.play().catch(() => undefined);
      });
      v.play().catch(() => undefined);
      this.portraitVideos.set(p.agentId, v);
    }
  }

  private buildSpiral(n: number) {
    const golden = Math.PI * (3 - Math.sqrt(5));
    this.spiral = [];
    for (let i = 0; i < n; i++) {
      const r = Math.sqrt(i / Math.max(1, n - 1));
      const a = i * golden;
      this.spiral.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
    }
  }

  resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    this.W = rect.width;
    this.H = rect.height;
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  render(gameTime: number, dtSec: number) {
    this.realT += dtSec;
    const ctx = this.ctx;
    const { W, H } = this;

    // background
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, VOID);
    bg.addColorStop(1, '#05050a');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    this.drawVignette();

    const headerH = Math.min(64, H * 0.1);
    const footerH = Math.min(118, H * 0.2);
    const pad = 14;
    const bodyY = headerH + pad;
    const bodyH = H - headerH - footerH - pad * 2;
    const rightW = clamp(W * 0.2, 150, 280);
    const leftW = (W - rightW - pad * 4) * 0.52;
    const centerW = W - rightW - leftW - pad * 4;

    const leftR: Rect = { x: pad, y: bodyY, w: leftW, h: bodyH };
    const centerR: Rect = { x: pad * 2 + leftW, y: bodyY, w: centerW, h: bodyH };
    const rightR: Rect = { x: pad * 3 + leftW + centerW, y: bodyY, w: rightW, h: bodyH };
    const footerR: Rect = { x: pad, y: H - footerH - pad, w: W - pad * 2, h: footerH };

    this.detectEvents(gameTime);

    this.drawHeader(gameTime, headerH);
    this.drawMarkets(leftR);
    this.drawArena(centerR, gameTime);
    this.drawStats(rightR, gameTime);
    this.drawBillboard(footerR, gameTime);
    this.drawToasts();
    this.drawIntro();
    this.drawFinale();
  }

  // ---- panels -------------------------------------------------------------

  private drawHeader(gameTime: number, h: number) {
    const ctx = this.ctx;
    const meta = this.world.bundle.meta;
    ctx.save();
    ctx.fillStyle = 'rgba(215,215,223,0.018)';
    ctx.fillRect(0, 0, this.W, h);
    ctx.strokeStyle = HAIR;
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.lineTo(this.W, h);
    ctx.stroke();

    // title
    ctx.textBaseline = 'middle';
    ctx.font = `italic 700 ${Math.min(24, h * 0.43)}px ${FONT_DISPLAY}`;
    this.chromeText(PRODUCT_NAME, 18, h / 2 - 1, ctx.font);
    const tw = ctx.measureText(PRODUCT_NAME).width;
    ctx.font = `700 ${Math.min(12, h * 0.22)}px ${FONT_MONO}`;
    ctx.fillStyle = 'rgba(138,138,150,0.78)';
    ctx.fillText(`· ${meta.seasonLabel.toUpperCase()} · ${meta.ensDomain}`, 18 + tw + 10, h / 2);

    // REC dot (blinks)
    const blink = 0.5 + 0.5 * Math.sin(this.realT * 4);
    ctx.fillStyle = `rgba(255,106,44,${0.35 + blink * 0.35})`;
    ctx.beginPath();
    ctx.arc(this.W - 150, h / 2, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(215,215,223,0.68)';
    ctx.font = `600 11px ${FONT_MONO}`;
    ctx.fillText('REPLAY', this.W - 138, h / 2);

    // game clock
    ctx.textAlign = 'right';
    ctx.font = `700 ${Math.min(18, h * 0.32)}px ${FONT_MONO}`;
    ctx.fillStyle = BONE;
    ctx.fillText(`T+${elapsed(gameTime, meta.startTime)}`, this.W - 18, h / 2 - 7);
    ctx.font = `500 10px ${FONT_MONO}`;
    ctx.fillStyle = 'rgba(138,138,150,0.78)';
    ctx.fillText(meta.arena, this.W - 18, h / 2 + 9);
    ctx.textAlign = 'left';
    ctx.restore();
  }

  private drawMarkets(r: Rect) {
    this.panelLabel(r, 'MARKETS');
    const markets = this.world.marketList().filter((m) => m.created);
    const top = r.y + 22;
    const gridH = r.h - 22;
    const cols = markets.length > 4 ? 2 : 1;
    const rows = Math.ceil(Math.max(1, markets.length) / cols);
    const gap = 8;
    const cw = (r.w - gap * (cols - 1)) / cols;
    const ch = (gridH - gap * (rows - 1)) / Math.max(1, rows);

    markets.forEach((ms, i) => {
      const cx = r.x + (i % cols) * (cw + gap);
      const cy = top + Math.floor(i / cols) * (ch + gap);
      this.drawMarketChart({ x: cx, y: cy, w: cw, h: ch }, ms, MARKET_STROKES[i % MARKET_STROKES.length]);
    });
  }

  private drawMarketChart(r: Rect, ms: MarketState, color: string) {
    const ctx = this.ctx;
    const meta = this.world.bundle.meta;
    // card
    ctx.save();
    this.roundRect(r.x, r.y, r.w, r.h, 8);
    ctx.fillStyle = 'rgba(215,215,223,0.025)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(215,215,223,0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.clip();

    // current YES price (big, top-right)
    const yes = ms.currentYes;
    ctx.font = `700 19px ${FONT_MONO}`;
    ctx.fillStyle = BONE;
    ctx.textAlign = 'right';
    ctx.fillText(`${(yes * 100).toFixed(0)}%`, r.x + r.w - 10, r.y + 20);
    const priceW = ctx.measureText(`${(yes * 100).toFixed(0)}%`).width + 16;
    ctx.textAlign = 'left';

    // title — wrapped to at most 2 lines, larger for readability
    ctx.font = `600 13px ${FONT_MONO}`;
    ctx.fillStyle = 'rgba(215,215,223,0.9)';
    const lines = this.wrapLines(ms.market.question, r.w - priceW - 18, 2);
    lines.forEach((ln, i) => ctx.fillText(ln, r.x + 10, r.y + 16 + i * 15));

    // plot area starts below the title block
    const px = r.x + 10;
    const py = r.y + 16 + lines.length * 15 + 4;
    const pw = r.w - 20;
    const ph = r.y + r.h - py - 14;
    // baseline 50%
    ctx.strokeStyle = 'rgba(215,215,223,0.07)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(px, py + ph * 0.5);
    ctx.lineTo(px + pw, py + ph * 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    const span = meta.endTime - meta.startTime;
    const xAt = (t: number) => px + (clamp((t - meta.startTime) / span, 0, 1)) * pw;
    const yAt = (v: number) => py + (1 - v) * ph;

    const pts = ms.points;
    const n = ms.visibleCount;
    if (n > 0) {
      // area fill
      ctx.beginPath();
      ctx.moveTo(xAt(pts[0].t), yAt(pts[0].yes));
      for (let i = 1; i < n; i++) ctx.lineTo(xAt(pts[i].t), yAt(pts[i].yes));
      const headX = xAt(pts[n - 1].t);
      ctx.lineTo(headX, py + ph);
      ctx.lineTo(xAt(pts[0].t), py + ph);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, py, 0, py + ph);
      grad.addColorStop(0, 'rgba(215,215,223,0.14)');
      grad.addColorStop(1, 'rgba(139,123,255,0)');
      ctx.fillStyle = grad;
      ctx.fill();

      // line
      ctx.beginPath();
      ctx.moveTo(xAt(pts[0].t), yAt(pts[0].yes));
      for (let i = 1; i < n; i++) ctx.lineTo(xAt(pts[i].t), yAt(pts[i].yes));
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.shadowColor = color;
      ctx.shadowBlur = 6;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // head dot
      const hx = xAt(pts[n - 1].t);
      const hy = yAt(pts[n - 1].yes);
      const pulse = 2.5 + Math.sin(this.realT * 6) * 0.8;
      ctx.fillStyle = BONE;
      ctx.beginPath();
      ctx.arc(hx, hy, pulse, 0, Math.PI * 2);
      ctx.fill();
    }

    if (ms.resolved && ms.market.outcome) {
      ctx.fillStyle = ms.market.outcome === 'Yes' ? 'rgba(231,227,217,0.95)' : 'rgba(255,106,44,0.95)';
      ctx.font = `700 11px ${FONT_MONO}`;
      ctx.fillText(`✓ RESOLVED ${ms.market.outcome.toUpperCase()}`, r.x + 10, r.y + r.h - 8);
    }
    ctx.restore();
  }

  /** Wrap text to <= maxLines lines that fit maxW; last line gets an ellipsis if clipped. */
  private wrapLines(text: string, maxW: number, maxLines: number): string[] {
    const ctx = this.ctx;
    const words = text.split(' ');
    const lines: string[] = [];
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && line) {
        lines.push(line);
        line = w;
        if (lines.length === maxLines) break;
      } else line = test;
    }
    if (lines.length < maxLines && line) lines.push(line);
    // if we ran out of lines but text remains, ellipsize the last line
    const used = lines.join(' ');
    if (used.replace(/\s+/g, ' ') !== text.replace(/\s+/g, ' ') && lines.length) {
      let last = lines[lines.length - 1];
      while (ctx.measureText(last + '…').width > maxW && last.length > 1) last = last.slice(0, -1);
      lines[lines.length - 1] = last + '…';
    }
    return lines;
  }

  private drawArena(r: Rect, gameTime: number) {
    const ctx = this.ctx;
    this.panelLabel(r, 'DAEMON HALL');
    const cx = r.x + r.w / 2;
    const cy = r.y + 22 + (r.h - 22) / 2;
    const rad = Math.min(r.w, r.h - 22) * 0.42;

    // ambient ring
    ctx.save();
    ctx.strokeStyle = 'rgba(139,123,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, rad * 1.08, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    const states = [...this.world.playerStates.values()];
    const joinedCount = states.filter((s) => s.joined).length || 1;
    const maxEq = Math.max(...states.map((s) => s.equity), 1);

    // trade tracers (player -> arena center burst)
    const window = (this.world.bundle.meta.endTime - this.world.bundle.meta.startTime) * 0.01;
    const recent = this.world.recentTrades(gameTime, window).slice(0, 60);

    // node positions
    const posOf = (idx: number) => ({
      x: cx + this.spiral[idx].x * rad,
      y: cy + this.spiral[idx].y * rad,
    });
    const indexById = new Map<string, number>();
    this.world.bundle.players.forEach((p, i) => indexById.set(p.agentId, i));

    // draw tracers under nodes
    for (const tr of recent) {
      const idx = indexById.get(tr.agentId);
      if (idx === undefined) continue;
      const pos = posOf(idx);
      const age = clamp((gameTime - tr.t) / window, 0, 1);
      const alpha = (1 - age) * 0.5;
      const big = tr.notional > 200;
      ctx.strokeStyle = `rgba(36,36,46,${0.25 + alpha * 0.45})`;
      ctx.lineWidth = big ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
      const mid = lerp(0, 1, age);
      ctx.lineTo(lerp(pos.x, cx, mid), lerp(pos.y, cy, mid));
      ctx.stroke();
    }

    // nodes
    const sorted = states.slice().sort((a, b) => a.equity - b.equity); // draw big last
    for (const s of sorted) {
      const idx = indexById.get(s.player.agentId)!;
      const pos = posOf(idx);
      // join animation: scale up over a short game-window after joinedAt
      const joinAge = (gameTime - s.player.joinedAt) / ((this.world.bundle.meta.endTime - this.world.bundle.meta.startTime) * 0.02);
      const appear = s.joined ? easeOut(clamp(joinAge, 0, 1)) : 0;
      if (appear <= 0.001) continue;

      // Size by equity relative to the field's top. Losing daemons can go to
      // negative equity, so clamp the ratio to [0,1] (broke-but-present nodes
      // stay small) — a negative radius would throw in ctx.arc / gradients.
      const base = 5 + clamp(s.equity / maxEq, 0, 1) * 15;
      // pulse on recent trade
      const tradeAge = (gameTime - s.lastTradeT) / window;
      const pulse = tradeAge >= 0 && tradeAge < 1 ? (1 - tradeAge) * 6 : 0;
      const rNode = Math.max(0, (base + pulse) * appear);
      const up = s.pnl >= 0;
      const heat = clamp(Math.abs(s.pnl) / 260, 0, 1);
      const killed = s.equity < s.player.deposited * 0.18;
      const core = s.rank === 1 ? BONE : up ? `rgba(215,215,223,${0.5 + heat * 0.42})` : `rgba(255,106,44,${0.35 + heat * 0.45})`;

      // glow
      const g = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, rNode * (killed ? 3.2 : 2.4));
      g.addColorStop(0, up ? `rgba(231,227,217,${0.2 + heat * 0.35})` : `rgba(255,106,44,${0.16 + heat * 0.34})`);
      g.addColorStop(1, 'rgba(139,123,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, rNode * 2.4, 0, Math.PI * 2);
      ctx.fill();

      // core
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, rNode, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = s.rank === 1 ? 'rgba(231,227,217,0.9)' : up ? 'rgba(139,123,255,0.42)' : 'rgba(255,106,44,0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // leader crown
      if (s.rank === 1 && s.joined) {
        ctx.fillStyle = `rgba(231,227,217,0.95)`;
        ctx.font = `${Math.max(10, rNode)}px ${FONT_DISPLAY}`;
        ctx.textAlign = 'center';
        ctx.fillText('♛', pos.x, pos.y - rNode - 6);
        ctx.textAlign = 'left';
      }
      // label for the big ones
      if (rNode > 11) {
        ctx.fillStyle = `rgba(215,215,223,${0.8 * appear})`;
        ctx.font = `600 9px ${FONT_MONO}`;
        ctx.textAlign = 'center';
        ctx.fillText(s.player.name, pos.x, pos.y + rNode + 9);
        ctx.textAlign = 'left';
      }
    }

    // center counter
    ctx.fillStyle = 'rgba(231,227,217,0.94)';
    ctx.font = `700 20px ${FONT_MONO}`;
    ctx.textAlign = 'center';
    ctx.fillText(`${joinedCount}`, cx, cy - 2);
    ctx.font = `500 9px ${FONT_MONO}`;
    ctx.fillStyle = 'rgba(138,138,150,0.78)';
    ctx.fillText('DAEMONS LIVE', cx, cy + 14);
    ctx.textAlign = 'left';
  }

  private drawStats(r: Rect, gameTime: number) {
    const ctx = this.ctx;
    this.panelLabel(r, 'VAULT');
    const tvl = this.world.tvlAt(gameTime);
    const maxTvl = this.world.bundle.tvl[this.world.bundle.tvl.length - 1]?.tvl || 1;

    // big TVL number
    let y = r.y + 30;
    ctx.fillStyle = 'rgba(231,227,217,0.95)';
    ctx.font = `700 24px ${FONT_MONO}`;
    ctx.fillText(usd(tvl), r.x, y + 10);
    ctx.fillStyle = 'rgba(138,138,150,0.78)';
    ctx.font = `500 9px ${FONT_MONO}`;
    ctx.fillText('TOTAL VALUE LOCKED', r.x, y + 26);

    // growing vertical bar
    const barTop = y + 40;
    const barBottom = r.y + r.h - 96;
    const barH = barBottom - barTop;
    const barW = 26;
    const bx = r.x;
    ctx.fillStyle = 'rgba(215,215,223,0.05)';
    this.roundRect(bx, barTop, barW, barH, 5);
    ctx.fill();
    const fillH = barH * clamp(tvl / maxTvl, 0, 1);
    const grad = ctx.createLinearGradient(0, barBottom, 0, barTop);
    grad.addColorStop(0, 'rgba(231,227,217,0.95)');
    grad.addColorStop(1, 'rgba(231,227,217,0.95)');
    ctx.fillStyle = grad;
    this.roundRect(bx, barBottom - fillH, barW, fillH, 5);
    ctx.fill();

    // counters to the right of the bar
    const cumTrades = this.countTrades(gameTime);
    const vol = this.cumVolume(gameTime);
    const liveMarkets = this.world.marketList().filter((m) => m.created && !m.resolved).length;
    const liveDaemons = this.world.rankedPlayers().length;
    const stats: [string, string][] = [
      ['VOLUME', usd(vol)],
      ['TRADES', cumTrades.toLocaleString()],
      ['MARKETS', `${liveMarkets}`],
      ['DAEMONS', `${liveDaemons}`],
    ];
    let sy = barTop + 6;
    const sx = bx + barW + 14;
    for (const [k, v] of stats) {
      ctx.fillStyle = 'rgba(231,227,217,0.94)';
      ctx.font = `700 16px ${FONT_MONO}`;
      ctx.fillText(v, sx, sy + 12);
      ctx.fillStyle = 'rgba(138,138,150,0.68)';
      ctx.font = `500 8px ${FONT_MONO}`;
      ctx.fillText(k, sx, sy + 24);
      sy += 38;
    }

    // mini leaderboard at the bottom
    const lbTop = r.y + r.h - 84;
    ctx.fillStyle = 'rgba(138,138,150,0.68)';
    ctx.font = `600 9px ${FONT_MONO}`;
    ctx.fillText('LEADERBOARD', r.x, lbTop);
    const lead = this.world.rankedPlayers().slice(0, 4);
    lead.forEach((s, i) => {
      const ly = lbTop + 14 + i * 16;
      ctx.fillStyle = s.rank === 1 ? BONE : 'rgba(139,123,255,0.58)';
      ctx.beginPath();
      ctx.arc(r.x + 4, ly - 3, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(215,215,223,0.88)';
      ctx.font = `600 10px ${FONT_MONO}`;
      ctx.fillText(`${i + 1} ${s.player.name}`, r.x + 12, ly);
      ctx.textAlign = 'right';
      ctx.fillStyle = s.pnl >= 0 ? 'rgba(231,227,217,0.95)' : 'rgba(255,106,44,0.92)';
      ctx.fillText(signed(s.pnl), r.x + r.w, ly);
      ctx.textAlign = 'left';
    });
  }

  private drawBillboard(r: Rect, gameTime: number) {
    const ctx = this.ctx;
    ctx.save();
    this.roundRect(r.x, r.y, r.w, r.h, 10);
    const grad = ctx.createLinearGradient(r.x, r.y, r.x, r.y + r.h);
    grad.addColorStop(0, 'rgba(40,20,60,0.5)');
    grad.addColorStop(1, 'rgba(20,10,30,0.5)');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(139,123,255,0.2)';
    ctx.stroke();
    ctx.clip();

    ctx.fillStyle = 'rgba(139,123,255,0.7)';
    ctx.font = `600 10px ${FONT_MONO}`;
    ctx.fillText('▌ BILLBOARD', r.x + 14, r.y + 16);

    const post = this.world.latestPost(gameTime);
    if (post) {
      const author = this.world.player(post.agentId);
      const age = this.realT; // for glow phase
      const ageGame = gameTime - post.t;
      const fresh = clamp(1 - ageGame / ((this.world.bundle.meta.endTime - this.world.bundle.meta.startTime) * 0.03), 0, 1);
      // author chip
      ctx.fillStyle = post.spicy ? 'rgba(255,106,44,0.74)' : 'rgba(139,123,255,0.66)';
      ctx.beginPath();
      ctx.arc(r.x + 20, r.y + 44, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = BONE;
      ctx.font = `700 12px ${FONT_MONO}`;
      ctx.fillText(`${author?.name ?? 'daemon'}`, r.x + 34, r.y + 48);

      // message — spicy posts get bigger + glow
      const big = post.spicy;
      ctx.font = `${big ? '700' : '500'} ${big ? 22 : 18}px ${FONT_MONO}`;
      ctx.fillStyle = big
        ? `rgba(255,106,44,${0.78 + fresh * 0.16})`
        : `rgba(215,215,223,${0.7 + fresh * 0.3})`;
      if (big) {
        ctx.shadowColor = 'rgba(255,106,44,0.55)';
        ctx.shadowBlur = 18 * (0.6 + 0.4 * Math.sin(age * 5));
      }
      const typed = post.message.slice(0, Math.max(1, Math.floor((ageGame / this.gWindow(0.012)) * post.message.length)));
      const msg = `“${typed}${typed.length < post.message.length ? '▌' : ''}”`;
      this.fitText(msg, r.x + 14, r.y + 80, r.w - 28, big ? 22 : 18);
      ctx.shadowBlur = 0;

      if (big) {
        ctx.fillStyle = 'rgba(255,106,44,0.82)';
        ctx.font = `700 10px ${FONT_MONO}`;
        ctx.textAlign = 'right';
        ctx.fillText('RUMOUR · UNVERIFIED', r.x + r.w - 14, r.y + 18);
        ctx.textAlign = 'left';
      }
    }
    ctx.restore();
  }

  // ---- overlays -----------------------------------------------------------

  private drawToasts() {
    const ctx = this.ctx;
    const now = this.realT;
    this.toasts = this.toasts.filter((t) => now - t.born < t.life);
    let i = 0;
    for (const t of this.toasts) {
      const age = (now - t.born) / t.life;
      const inT = easeOut(clamp(age / 0.15, 0, 1));
      const outT = age > 0.8 ? (age - 0.8) / 0.2 : 0;
      const alpha = inT * (1 - outT);
      const y = this.H * 0.5 - 60 - i * 46 + (1 - inT) * 16;
      const x = this.W * 0.5;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.textAlign = 'center';
      ctx.font = `700 20px ${FONT_MONO}`;
      ctx.fillStyle = t.color;
      ctx.shadowColor = t.color;
      ctx.shadowBlur = 16;
      ctx.fillText(t.text, x, y);
      ctx.shadowBlur = 0;
      ctx.font = `500 11px ${FONT_MONO}`;
      ctx.fillStyle = 'rgba(215,215,223,0.72)';
      ctx.fillText(t.sub, x, y + 16);
      ctx.restore();
      i++;
    }
    ctx.textAlign = 'left';
  }

  private drawIntro() {
    const p = this.clock.getProgress();
    if (p > 0.04) return;
    const a = 1 - p / 0.04;
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = `rgba(5,5,12,${a})`;
    ctx.fillRect(0, 0, this.W, this.H);
    ctx.globalAlpha = a;
    ctx.textAlign = 'center';
    const titleFont = `italic 700 ${Math.min(64, this.W * 0.07)}px ${FONT_DISPLAY}`;
    this.chromeText(PRODUCT_NAME, this.W / 2, this.H / 2 - 14, titleFont, 'center');
    ctx.font = `700 16px ${FONT_MONO}`;
    ctx.fillStyle = 'rgba(139,123,255,0.88)';
    ctx.fillText(`${this.world.bundle.meta.seasonLabel.toUpperCase()} · ${this.world.bundle.meta.ensDomain}`, this.W / 2, this.H / 2 + 32);
    ctx.restore();
    ctx.textAlign = 'left';
  }

  private drawFinale() {
    const p = this.clock.getProgress();
    if (p < 0.82) return;
    const u = clamp((p - 0.82) / 0.18, 0, 1);
    const ctx = this.ctx;
    const cx = this.W / 2;
    const champion = this.world.rankedPlayers().find((s) => s.player.name === 'larpd') ?? this.world.rankedPlayers()[0];
    ctx.save();

    // Clean reveal stage: no legible dashboard bleed.
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(10,10,15,0.98)';
    ctx.fillRect(0, 0, this.W, this.H);

    // Barely-there daemon husks only.
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + this.realT * 0.04;
      const rr = Math.min(this.W, this.H) * (0.28 + (i % 3) * 0.055);
      ctx.globalAlpha = 0.03;
      ctx.fillStyle = i % 4 === 0 ? EMBER : SILVER;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * rr, this.H * 0.52 + Math.sin(a) * rr * 0.55, 7 + (i % 3) * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Beat 1: seam crack → title.
    if (u < 0.15) {
      const k = easeOut(u / 0.15);
      this.drawSeamCrack(k);
      this.chromeText('THE BOX HAS OPENED', cx, this.H * 0.48, `italic 700 ${Math.min(54, this.W * 0.052)}px ${FONT_DISPLAY}`, 'center', k);
      ctx.restore();
      return;
    }

    // Beat 2: full hall card wall for ~5 seconds in the 2x export.
    if (u < 0.86) {
      const k = easeOut((u - 0.15) / 0.12);
      this.chromeText('THE BOX HAS OPENED', cx, this.H * 0.075, `italic 700 ${Math.min(34, this.W * 0.036)}px ${FONT_DISPLAY}`, 'center', k);
      ctx.textAlign = 'center';
      ctx.font = `800 12px ${FONT_MONO}`;
      ctx.fillStyle = 'rgba(139,123,255,0.82)';
      ctx.fillText('THE WHOLE HALL', cx, this.H * 0.115);
      this.drawDaemonReel(this.W * 0.055, this.H * 0.16, this.W * 0.89, this.H * 0.68, k);
      ctx.restore();
      return;
    }

    // Final slide: left champion portrait card, right award board. Recorder holds this for 30s.
    const k = easeOut((u - 0.86) / 0.14);
    this.drawChampionAwardsSlide(champion, k);
    ctx.restore();
    ctx.textAlign = 'left';
  }


  private drawChampionAwardsSlide(champion: ReturnType<World['rankedPlayers']>[number] | undefined, alpha: number) {
    if (!champion) return;
    const ctx = this.ctx;
    const cx = this.W / 2;
    ctx.save();
    ctx.globalAlpha = alpha;

    this.chromeText('THE BOX HAS OPENED', cx, this.H * 0.085, `italic 700 ${Math.min(38, this.W * 0.038)}px ${FONT_DISPLAY}`, 'center', alpha);

    const margin = this.W * 0.08;
    const gap = this.W * 0.055;
    const leftW = Math.min(this.W * 0.27, 330);
    const leftH = this.H * 0.73;
    const leftX = margin;
    const leftY = this.H * 0.17;
    const rightX = leftX + leftW + gap;
    const rightW = this.W - rightX - margin;
    const rightY = leftY + 10;

    // Winner glow focused on the left card.
    const glow = ctx.createRadialGradient(leftX + leftW / 2, leftY + leftH * 0.36, 20, leftX + leftW / 2, leftY + leftH * 0.36, leftW * 0.85);
    glow.addColorStop(0, 'rgba(231,227,217,0.18)');
    glow.addColorStop(0.45, 'rgba(139,123,255,0.08)');
    glow.addColorStop(1, 'rgba(10,10,15,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, this.W, this.H);

    // Champion card — portrait format video, no grid.
    ctx.save();
    this.roundRect(leftX, leftY, leftW, leftH, 22);
    ctx.fillStyle = 'rgba(14,14,21,0.95)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(231,227,217,0.32)';
    ctx.lineWidth = 1.3;
    ctx.stroke();
    ctx.clip();

    const mediaY = leftY + leftH * 0.06;
    const mediaH = leftH * 0.57;
    const mediaW = Math.min(leftW * 0.76, mediaH * 0.753);
    const mediaX = leftX + (leftW - mediaW) / 2;
    this.drawPortraitMedia(champion, mediaX, mediaY, mediaW, mediaH, true, false);

    const nameY = mediaY + mediaH + leftH * 0.105;
    this.chromeText(champion.player.name, leftX + leftW / 2, nameY, `italic 800 ${Math.min(56, leftW * 0.15)}px ${FONT_DISPLAY}`, 'center', alpha);

    const chip = champion.player.ensName;
    ctx.font = `700 ${Math.min(13, leftW * 0.034)}px ${FONT_MONO}`;
    const chipW = Math.min(leftW - 44, ctx.measureText(chip).width + 28);
    const chipH = 28;
    this.roundRect(leftX + leftW / 2 - chipW / 2, nameY + 18, chipW, chipH, 14);
    ctx.fillStyle = 'rgba(10,10,15,0.82)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(139,123,255,0.62)';
    ctx.stroke();
    ctx.fillStyle = SILVER;
    ctx.textAlign = 'center';
    ctx.fillText(chip, leftX + leftW / 2, nameY + 37);

    ctx.font = `900 ${Math.min(21, leftW * 0.052)}px ${FONT_MONO}`;
    ctx.fillStyle = BONE;
    ctx.fillText('♛ CHAMPION · +$875', leftX + leftW / 2, nameY + 78);
    ctx.font = `700 ${Math.min(12, leftW * 0.038)}px ${FONT_MONO}`;
    ctx.fillStyle = 'rgba(215,215,223,0.78)';
    ctx.fillText('the pretender', leftX + leftW / 2, nameY + 94);
    ctx.fillText('all conviction, no position', leftX + leftW / 2, nameY + 110);
    ctx.restore();

    // Right: other awards as the final readable board.
    ctx.textAlign = 'left';
    this.chromeText('BEST MOMENTS', rightX, rightY + 10, `italic 800 ${Math.min(34, rightW * 0.07)}px ${FONT_DISPLAY}`, 'left', alpha);
    const awards = this.world.awards().filter((a) => a.title !== 'CHAMPION').slice(0, 8);
    const rowH = Math.min(46, (leftH - 90) / awards.length);
    awards.forEach((aw, i) => {
      const y = rightY + 62 + i * rowH;
      const rowAlpha = alpha * clamp((alpha - i * 0.025) / 0.2, 0, 1);
      ctx.globalAlpha = rowAlpha;
      ctx.font = `900 ${Math.min(15, rowH * 0.34)}px ${FONT_MONO}`;
      ctx.fillStyle = SILVER;
      ctx.fillText(aw.title, rightX, y);
      ctx.font = `italic 800 ${Math.min(18, rowH * 0.38)}px ${FONT_DISPLAY}`;
      this.chromeText(aw.name, rightX + Math.min(250, rightW * 0.48), y, ctx.font, 'left', rowAlpha);
      ctx.font = `500 ${Math.min(11, rowH * 0.24)}px ${FONT_MONO}`;
      ctx.fillStyle = 'rgba(138,138,150,0.86)';
      ctx.fillText(aw.detail, rightX, y + 16);
    });

    ctx.globalAlpha = alpha;

    ctx.restore();
    ctx.textAlign = 'left';
  }


  // ---- events -------------------------------------------------------------

  private detectEvents(gameTime: number) {
    for (const ms of this.world.marketList()) {
      if (ms.created && !this.seenCreated.has(ms.market.marketId) && gameTime - ms.market.createdAt < this.gWindow(0.02)) {
        if (ms.market.createdAt <= gameTime) {
          this.seenCreated.add(ms.market.marketId);
          this.pushToast('NEW MARKET', ms.market.question, 'rgba(150,200,255,0.95)');
        }
      }
      if (ms.resolved && ms.market.outcome && !this.seenResolved.has(ms.market.marketId)) {
        this.seenResolved.add(ms.market.marketId);
        const c = ms.market.outcome === 'Yes' ? 'rgba(231,227,217,0.95)' : 'rgba(255,106,44,0.95)';
        this.pushToast(`RESOLVED · ${ms.market.outcome.toUpperCase()}`, ms.market.question, c);
      }
    }
    // whale trades
    for (const tr of this.world.recentTrades(gameTime, this.gWindow(0.006))) {
      const key = `${tr.t}-${tr.agentId}-${tr.marketId}`;
      if (tr.notional >= 350 && !this.seenWhales.has(key)) {
        this.seenWhales.add(key);
        const who = this.world.player(tr.agentId)?.name ?? 'a daemon';
        this.pushToast('🐋 WHALE', `${who} ${tr.side === 'buy' ? 'bought' : 'sold'} ${usd(tr.notional)} ${tr.outcome}`, 'rgba(255,106,44,0.95)');
      }
    }
    // reset dedup sets on loop wrap
    if (gameTime <= this.world.bundle.meta.startTime + this.gWindow(0.005)) {
      if (this.seenCreated.size > 1 || this.seenResolved.size) {
        this.seenCreated.clear();
        this.seenResolved.clear();
        this.seenWhales.clear();
      }
    }
  }

  private pushToast(text: string, sub: string, color: string) {
    if (this.toasts.length > 4) this.toasts.shift();
    this.toasts.push({ text, sub, color, born: this.realT, life: 3.2 });
  }

  // ---- helpers ------------------------------------------------------------

  private chromeText(text: string, x: number, y: number, font: string, align: CanvasTextAlign = 'left', alpha = 1) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = font;
    ctx.textAlign = align;
    const w = Math.max(1, ctx.measureText(text).width);
    const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    const grad = ctx.createLinearGradient(left, y - 34, left + w, y + 10);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.48, '#bcbcc6');
    grad.addColorStop(1, '#ececf2');
    ctx.fillStyle = grad;
    ctx.shadowColor = 'rgba(255,255,255,0.28)';
    ctx.shadowBlur = 10;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  private drawSeamCrack(alpha: number) {
    const ctx = this.ctx;
    const cx = this.W / 2;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = EMBER;
    ctx.shadowColor = EMBER;
    ctx.shadowBlur = 28;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    for (let y = this.H * 0.12; y < this.H * 0.9; y += 28) {
      const wobble = Math.sin(y * 0.035 + this.realT * 4) * 14;
      if (y === this.H * 0.12) ctx.moveTo(cx + wobble, y);
      else ctx.lineTo(cx + wobble, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawPortraitMedia(
    s: ReturnType<World['rankedPlayers']>[number],
    x: number,
    y: number,
    w: number,
    h: number,
    hero = false,
    stillOnly = false,
  ) {
    const ctx = this.ctx;
    const video = this.portraitVideos.get(s.player.agentId);
    const img = this.portraitImages.get(s.player.agentId);
    ctx.save();
    this.roundRect(x, y, w, h, hero ? 18 : 8);
    ctx.clip();
    ctx.fillStyle = VOID;
    ctx.fillRect(x, y, w, h);

    if (stillOnly && img && img.complete && img.naturalWidth > 0) {
      // Wall slide: stills only, top-aligned crop so heads stay visible.
      const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
      const dw = img.naturalWidth * scale;
      const dh = img.naturalHeight * scale;
      const dx = x + (w - dw) / 2;
      const dy = y + Math.min(0, (h - dh) * 0.04) + h * 0.035;
      ctx.filter = 'saturate(0.16) contrast(1.16) brightness(0.94)';
      ctx.drawImage(img, dx, dy, dw, dh);
      ctx.filter = 'none';
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = s.pnl >= 0 ? 'rgba(231,227,217,0.09)' : 'rgba(255,106,44,0.08)';
      ctx.fillRect(x, y, w, h);
      ctx.globalCompositeOperation = 'source-over';
    } else if (!stillOnly && video && video.readyState >= 2 && video.videoWidth > 0) {
      if (video.paused) video.play().catch(() => undefined);
      if (Number.isFinite(video.duration) && video.duration > 0 && video.currentTime > video.duration - 0.08) video.currentTime = 0.03;
      // Hero slide: fit by height so the portrait video is not vertically cropped.
      const scale = hero ? h / video.videoHeight : Math.max(w / video.videoWidth, h / video.videoHeight);
      const dw = video.videoWidth * scale;
      const dh = video.videoHeight * scale;
      ctx.filter = 'saturate(0.18) contrast(1.18) brightness(0.92)';
      ctx.drawImage(video, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
      ctx.filter = 'none';
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = s.pnl >= 0 ? 'rgba(231,227,217,0.10)' : 'rgba(255,106,44,0.10)';
      ctx.fillRect(x, y, w, h);
      ctx.globalCompositeOperation = 'source-over';
    } else {
      // Broken/missing portrait fallback: dim seam-mark, never an orange block.
      const g = ctx.createRadialGradient(x + w / 2, y + h / 2, 4, x + w / 2, y + h / 2, Math.max(w, h) * 0.55);
      g.addColorStop(0, 'rgba(215,215,223,0.10)');
      g.addColorStop(1, 'rgba(10,10,15,0.98)');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = s.pnl >= 0 ? 'rgba(139,123,255,0.28)' : 'rgba(255,106,44,0.26)';
      ctx.lineWidth = hero ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x + w * 0.5, y + h * 0.16);
      ctx.lineTo(x + w * 0.47, y + h * 0.42);
      ctx.lineTo(x + w * 0.53, y + h * 0.62);
      ctx.lineTo(x + w * 0.49, y + h * 0.84);
      ctx.stroke();
    }
    const rim = ctx.createLinearGradient(x, y, x + w, y + h);
    rim.addColorStop(0, s.pnl >= 0 ? 'rgba(231,227,217,0.22)' : 'rgba(255,106,44,0.25)');
    rim.addColorStop(0.55, 'rgba(139,123,255,0.08)');
    rim.addColorStop(1, 'rgba(10,10,15,0.4)');
    ctx.strokeStyle = rim;
    ctx.lineWidth = hero ? 2 : 1;
    this.roundRect(x + 1, y + 1, w - 2, h - 2, hero ? 18 : 8);
    ctx.stroke();
    ctx.restore();
  }


  private drawDaemonReel(x: number, y: number, w: number, h: number, alpha: number) {
    const ctx = this.ctx;
    const ranked = this.world.rankedPlayers().slice(0, 16);
    const awards = new Map(this.world.awards().map((a) => [a.name, a.title]));
    const cols = 8;
    const rows = 2;
    const gap = 8;
    const tileW = (w - gap * (cols - 1)) / cols;
    const tileH = (h - gap * (rows - 1)) / rows;
    ranked.forEach((s, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const tx = x + col * (tileW + gap);
      const ty = y + row * (tileH + gap);
      const rowAlpha = alpha * clamp((alpha - i * 0.018) / 0.2, 0, 1);
      ctx.save();
      ctx.globalAlpha = rowAlpha;
      this.roundRect(tx, ty, tileW, tileH, 10);
      ctx.fillStyle = 'rgba(14,14,21,0.82)';
      ctx.fill();
      ctx.strokeStyle = s.pnl >= 0 ? 'rgba(231,227,217,0.22)' : 'rgba(255,106,44,0.28)';
      ctx.stroke();
      ctx.clip();

      const mediaH = tileH * 0.60;
      this.drawPortraitMedia(s, tx, ty + 3, tileW, mediaH - 3, false, true);
      const fade = ctx.createLinearGradient(0, ty + mediaH * 0.45, 0, ty + mediaH);
      fade.addColorStop(0, 'rgba(10,10,15,0)');
      fade.addColorStop(1, 'rgba(10,10,15,0.96)');
      ctx.fillStyle = fade;
      ctx.fillRect(tx, ty, tileW, mediaH);

      ctx.fillStyle = BONE;
      ctx.font = `800 10px ${FONT_DISPLAY}`;
      ctx.fillText(s.player.name, tx + 8, ty + mediaH + 13);
      ctx.fillStyle = 'rgba(139,123,255,0.86)';
      ctx.font = `600 7.5px ${FONT_MONO}`;
      ctx.fillText(s.player.ensName, tx + 8, ty + mediaH + 25);
      ctx.fillStyle = s.pnl >= 0 ? BONE : EMBER;
      ctx.font = `800 10px ${FONT_MONO}`;
      ctx.fillText(signed(s.pnl), tx + 8, ty + mediaH + 39);
      ctx.fillStyle = 'rgba(215,215,223,0.68)';
      ctx.font = `600 7px ${FONT_MONO}`;
      const label = awards.get(s.player.name) ?? s.player.epithet;
      ctx.fillText(label.slice(0, 25), tx + 8, ty + mediaH + 52);
      ctx.restore();
    });
  }

  private gWindow(frac: number): number {
    return (this.world.bundle.meta.endTime - this.world.bundle.meta.startTime) * frac;
  }

  private countTrades(gameTime: number): number {
    const trades = this.world.bundle.trades;
    let lo = 0;
    let hi = trades.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (trades[mid].t <= gameTime) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private cumVolume(gameTime: number): number {
    // approximate from TVL-correlated counter: sum notional up to count (cheap enough)
    const n = this.countTrades(gameTime);
    let v = 0;
    const trades = this.world.bundle.trades;
    for (let i = 0; i < n; i++) v += trades[i].notional;
    return v;
  }

  private panelLabel(r: Rect, label: string) {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(138,138,150,0.68)';
    ctx.font = `600 10px ${FONT_MONO}`;
    ctx.fillText(label, r.x, r.y + 8);
  }

  private fitText(text: string, x: number, y: number, maxW: number, size: number) {
    const ctx = this.ctx;
    const words = text.split(' ');
    let line = '';
    let yy = y;
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, x, yy);
        line = w;
        yy += size + 4;
      } else line = test;
    }
    if (line) ctx.fillText(line, x, yy);
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  private drawVignette() {
    const ctx = this.ctx;
    const g = ctx.createRadialGradient(this.W / 2, this.H / 2, this.H * 0.3, this.W / 2, this.H / 2, this.H * 0.8);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.W, this.H);
  }
}
