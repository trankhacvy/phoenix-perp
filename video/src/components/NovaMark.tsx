import { COLORS } from "../theme";

/**
 * The SuperNova mark: a 4-point sparkle/burst with the nova gradient + glow.
 * `progress` 0..1 drives ignition (scale + glow). `spin` adds slow rotation.
 */
export const NovaMark: React.FC<{ size?: number; progress?: number; spin?: number }> = ({
  size = 220,
  progress = 1,
  spin = 0,
}) => {
  const glow = Math.max(0, Math.min(1, progress));
  return (
    <div
      style={{
        width: size,
        height: size,
        position: "relative",
        transform: `scale(${0.2 + glow * 0.8}) rotate(${spin}deg)`,
        opacity: glow,
      }}
    >
      {/* halo */}
      <div
        style={{
          position: "absolute",
          inset: -size * 0.5,
          borderRadius: "50%",
          background: `radial-gradient(circle, rgba(153,69,255,${0.55 * glow}) 0%, rgba(20,241,149,${0.18 * glow}) 35%, rgba(5,5,15,0) 68%)`,
          filter: "blur(6px)",
        }}
      />
      <svg
        viewBox="-50 -50 100 100"
        width={size}
        height={size}
        style={{ position: "relative", filter: `drop-shadow(0 0 ${18 * glow}px rgba(153,69,255,0.8))` }}
      >
        <defs>
          <linearGradient id="nova" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={COLORS.novaA} />
            <stop offset="100%" stopColor={COLORS.novaB} />
          </linearGradient>
        </defs>
        {/* four-point star: a concave-edged diamond */}
        <path
          d="M0,-46 C6,-12 12,-6 46,0 C12,6 6,12 0,46 C-6,12 -12,6 -46,0 C-12,-6 -6,-12 0,-46 Z"
          fill="url(#nova)"
        />
        {/* small secondary sparkle */}
        <path
          d="M30,-34 C32,-22 34,-20 46,-18 C34,-16 32,-14 30,-2 C28,-14 26,-16 14,-18 C26,-20 28,-22 30,-34 Z"
          fill="#FFFFFF"
          opacity={0.85 * glow}
          transform="scale(0.5) translate(36 -26)"
        />
      </svg>
    </div>
  );
};
