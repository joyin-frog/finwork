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
  hidden: { opacity: 0, scale: 0.96, y: 4 },
  visible: { opacity: 1, scale: 1, y: 0, transition: SPRING_DEFAULT },
  exit: { opacity: 0, scale: 0.98, y: 2, transition: EASE_OUT_QUICK_EXIT },
};

export const slideUpIn: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: SPRING_DEFAULT },
  exit: { opacity: 0, y: -4, transition: EASE_OUT_QUICK_EXIT },
};

export const listContainer: Variants = {
  hidden: { transition: { staggerChildren: 0.02, staggerDirection: -1 } },
  visible: { transition: { staggerChildren: 0.035, delayChildren: 0.04 } },
};
