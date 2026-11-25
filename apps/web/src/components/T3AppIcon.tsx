// The production icon, as GitHub shows the T3 Code app, whatever this build's channel.
import appIconUrl from "../../../../assets/prod/t3-black-web-apple-touch-180.png";

// The apple-touch export is full-bleed for iOS to mask; elsewhere it gets the icon set's corner.
const APP_ICON_STYLE = { borderRadius: "22.37%" };

export function T3AppIcon(props: { readonly className?: string }) {
  return <img src={appIconUrl} alt="" className={props.className} style={APP_ICON_STYLE} />;
}
