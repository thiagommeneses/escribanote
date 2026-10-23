import { Composition } from "remotion";
import { Lancamento, FPS, DURATION } from "./Lancamento";

export const Root = () => (
  <Composition id="Lancamento" component={Lancamento} durationInFrames={DURATION} fps={FPS} width={1920} height={1080} />
);
