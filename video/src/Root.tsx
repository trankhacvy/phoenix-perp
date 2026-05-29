import "./index.css";
import { Composition } from "remotion";
import { SuperNovaTeaser } from "./SuperNovaTeaser";
import { DURATION, FPS, HEIGHT, WIDTH } from "./timing";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="SuperNovaTeaser"
      component={SuperNovaTeaser}
      durationInFrames={DURATION}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
    />
  );
};
