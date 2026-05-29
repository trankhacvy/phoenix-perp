import { Img, staticFile } from "remotion";

/**
 * The SuperNova logo image. Black background is dropped via `screen` blend so
 * only the red burst shows on the dark canvas. `progress` 0..1 drives ignition.
 */
export const Logo: React.FC<{ size?: number; progress?: number }> = ({
  size = 300,
  progress = 1,
}) => {
  const g = Math.max(0, Math.min(1, progress));
  return (
    <div
      style={{
        width: size,
        height: size,
        position: "relative",
        transform: `scale(${0.25 + g * 0.75})`,
        opacity: g,
      }}
    >
      {/* red halo */}
      <div
        style={{
          position: "absolute",
          inset: -size * 0.28,
          borderRadius: "50%",
          background: `radial-gradient(circle, rgba(255,42,42,${0.5 * g}) 0%, rgba(255,42,42,${0.12 * g}) 40%, rgba(5,5,15,0) 68%)`,
          filter: "blur(6px)",
        }}
      />
      <Img
        src={staticFile("assets/logo.png")}
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          objectFit: "contain",
          filter: `drop-shadow(0 0 ${26 * g}px rgba(255,42,42,0.85))`,
        }}
      />
    </div>
  );
};
