import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

export function P0Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg
      accessibilityLabel="p0"
      height={props.height}
      width={(props.height * 83) / 61}
      viewBox="5 3 83 61"
    >
      <ThemedPath
        d="M10 22V64M10 37a15 15 0 1 0 30 0a15 15 0 1 0-30 0M53 30a15 22 0 1 0 30 0a15 22 0 1 0-30 0"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="none"
        stroke="currentColor"
        strokeWidth={10}
      />
    </Svg>
  );
}
