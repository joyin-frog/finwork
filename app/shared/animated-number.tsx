"use client";

import { useEffect } from "react";
import { animate, useMotionValue, useTransform, motion, useReducedMotion } from "motion/react";

export function AnimatedNumber({ value, duration = 0.9, format }: { value: number; duration?: number; format?: (v: number) => string }) {
  const prefersReduced = useReducedMotion();
  const mv = useMotionValue(0);
  const rounded = useTransform(mv, (v) => format ? format(v) : Math.round(v).toLocaleString());

  useEffect(() => {
    if (prefersReduced) {
      mv.set(value);
      return;
    }
    const controls = animate(mv, value, { duration, ease: [0.16, 1, 0.3, 1] });
    return () => controls.stop();
  }, [value, duration, mv, prefersReduced]);

  if (prefersReduced) {
    return <span>{format ? format(value) : value.toLocaleString()}</span>;
  }
  return <motion.span>{rounded}</motion.span>;
}
