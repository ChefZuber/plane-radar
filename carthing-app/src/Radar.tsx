import React, { useEffect, useRef } from "react";
import { PlaneView } from "./planes";

type Props = {
  planes: PlaneView[];
  selectedHex: string | null;
  rangeMi: number;
  size: number;
};

// Same look as the round desk display: teal scope, sweep, amber highlight.
const Radar: React.FC<Props> = ({ planes, selectedHex, rangeMi, size }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dataRef = useRef({ planes, selectedHex, rangeMi });
  dataRef.current = { planes, selectedHex, rangeMi };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let frame = 0;

    const draw = (now: number) => {
      const { planes, selectedHex, rangeMi } = dataRef.current;
      const c = size / 2;
      const R = c - 8;
      ctx.clearRect(0, 0, size, size);

      ctx.fillStyle = "#2C2C2A";
      ctx.beginPath(); ctx.arc(c, c, c, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#04342C";
      ctx.beginPath(); ctx.arc(c, c, R + 4, 0, Math.PI * 2); ctx.fill();

      // grid
      ctx.strokeStyle = "#085041"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(c - R, c); ctx.lineTo(c + R, c); ctx.moveTo(c, c - R); ctx.lineTo(c, c + R); ctx.stroke();
      ctx.strokeStyle = "#1D9E75"; ctx.setLineDash([4, 5]);
      ctx.font = "12px monospace"; ctx.fillStyle = "#5DCAA5";
      for (let i = 1; i <= 3; i++) {
        ctx.beginPath(); ctx.arc(c, c, (R * i) / 3, 0, Math.PI * 2); ctx.stroke();
        const v = (rangeMi * i) / 3;
        ctx.fillText(`${v < 10 ? v.toFixed(1) : Math.round(v)}mi`, c + (R * i) / 3 - 38, c + 14);
      }
      ctx.setLineDash([]);
      ctx.font = "bold 16px monospace"; ctx.textAlign = "center";
      ctx.fillText("N", c, c - R + 18); ctx.textAlign = "left";

      // sweep (one turn every 4 seconds)
      const sweep = ((now / 4000) * Math.PI * 2) % (Math.PI * 2);
      for (let i = 0; i < 40; i++) {
        const a = sweep - (i * Math.PI) / 360 - Math.PI / 2;
        ctx.strokeStyle = `rgba(29,158,117,${0.55 * (1 - i / 40)})`;
        ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(c + R * Math.cos(a), c + R * Math.sin(a)); ctx.stroke();
      }

      // planes
      let selected: PlaneView | null = null;
      for (const p of planes) {
        if (p.distMi > rangeMi) continue;
        if (p.hex === selectedHex) { selected = p; continue; }
        drawPlane(ctx, c + (p.east / rangeMi) * R, c - (p.north / rangeMi) * R, p, "#9FE1CB", "#5DCAA5", false);
      }
      if (selected) {
        const x = c + (selected.east / rangeMi) * R, y = c - (selected.north / rangeMi) * R;
        const ping = (now / 40) % 22;
        ctx.strokeStyle = `rgba(239,159,39,${1 - ping / 22})`; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, 6 + ping, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1;
        drawPlane(ctx, x, y, selected, "#EF9F27", "#FAC775", true);
      }

      ctx.fillStyle = "#FAC775";
      ctx.beginPath(); ctx.arc(c, c, 5, 0, Math.PI * 2); ctx.fill();
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [size]);

  return <canvas ref={canvasRef} width={size} height={size} style={{ width: size, height: size }} />;
};

function drawPlane(ctx: CanvasRenderingContext2D, x: number, y: number, p: PlaneView, fill: string, label: string, big: boolean) {
  ctx.save();
  ctx.translate(x, y);
  if (p.track !== null) {
    ctx.rotate((p.track * Math.PI) / 180);
    ctx.fillStyle = fill;
    ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(6, 7); ctx.lineTo(0, 3); ctx.lineTo(-6, 7); ctx.closePath(); ctx.fill();
  } else {
    ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(0, 0, 4, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  ctx.fillStyle = label;
  ctx.font = big ? "bold 15px monospace" : "11px monospace";
  ctx.fillText(p.callsign, x + 10, y - 8);
}

export default Radar;
