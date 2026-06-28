"use client";

import { motion, useReducedMotion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import type { HTMLMotionProps } from "motion/react";

const spinProps = {
  animate: { rotate: 360 },
  transition: { duration: 1.2, repeat: Infinity, ease: "linear" as const },
};

const pressProps = {
  whileTap: { scale: 0.85 },
  whileHover: { scale: 1.05 },
};

const shakeProps = {
  whileHover: { rotate: [0, -3, 3, -3, 0] as unknown as number[] },
  transition: { duration: 0.3 },
};

const presets = { spin: spinProps, press: pressProps, shake: shakeProps };

type Props = {
  as: IconSvgElement;
  preset: keyof typeof presets;
  size?: string;
  className?: string;
};

export function AnimatedIcon({ as: Cmp, preset, size = "var(--icon-md)", className }: Props) {
  const prefersReduced = useReducedMotion();

  const presetProps = prefersReduced ? {} : presets[preset];

  return (
    <motion.span style={{ display: "inline-flex" }} className={className} {...presetProps}>
      <HugeiconsIcon icon={Cmp} size={size} aria-hidden={true} />
    </motion.span>
  );
}
