import type { Variants, Transition } from "motion/react";

export const SPRING_DEFAULT: Transition = { type: "spring", stiffness: 260, damping: 24, mass: 0.7 };
export const EASE_OUT_QUICK: Transition = { duration: 0.18, ease: [0.16, 1, 0.3, 1] };
export const EASE_OUT_QUICK_EXIT: Transition = { duration: 0.12, ease: [0.4, 0, 1, 1] };

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: EASE_OUT_QUICK },
  exit: { opacity: 0, transition: EASE_OUT_QUICK_EXIT },
};

export const popIn: Variants = {
  hidden: { opacity: 0, transform: "translateY(4px) scale(0.96)" },
  visible: { opacity: 1, transform: "translateY(0px) scale(1)", transition: SPRING_DEFAULT },
  exit: { opacity: 0, transform: "translateY(2px) scale(0.98)", transition: EASE_OUT_QUICK_EXIT },
};

export const slideUpIn: Variants = {
  hidden: { opacity: 0, transform: "translateY(8px)" },
  visible: { opacity: 1, transform: "translateY(0px)", transition: SPRING_DEFAULT },
  exit: { opacity: 0, transform: "translateY(-4px)", transition: EASE_OUT_QUICK_EXIT },
};

export const listContainer: Variants = {
  hidden: { transition: { staggerChildren: 0.02, staggerDirection: -1 } },
  visible: { transition: { staggerChildren: 0.035, delayChildren: 0.04 } },
};
