import { Coins } from "@phosphor-icons/react/dist/ssr";
import { currencyIcon } from "@/app/lib/currency";

type Props = {
  size?: number | string;
  weight?: string; // unused — accepted for prop-shape parity with the Phosphor icons this replaces
  className?: string;
  style?: React.CSSProperties;
};

// The currency's picture: the install's own (`currency.icon`, set where the site is built), or
// the built-in coin glyph when it has none.
export default function PointsIcon({ size = "1em", className, style }: Props) {
  const dim = typeof size === "number" ? `${size}px` : size;
  const src = currencyIcon();
  if (!src) {
    return (
      <Coins
        aria-hidden="true"
        weight="fill"
        className={className}
        style={{ width: dim, height: dim, display: "inline-block", verticalAlign: "-0.15em", color: "#e5b53a", ...style }}
      />
    );
  }
  return (
    <img
      src={src}
      alt=""
      className={className}
      style={{ width: dim, height: dim, display: "inline-block", verticalAlign: "-0.15em", ...style }}
    />
  );
}
