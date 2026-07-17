import { useEffect, useRef, useState, type ReactNode } from "react";
import { animate, motion, useInView, useReducedMotion } from "motion/react";

/*
 * Motion primitives for the dashboard: a count-up hook for the hero figures and a
 * scroll-reveal wrapper for the chart cards. Both collapse to an instant, static
 * result under `prefers-reduced-motion` — the numbers just appear at their final value.
 */

/** Ease-out-expo — a fast, decisive settle that suits big counters. */
const EASE_OUT_EXPO: [number, number, number, number] = [0.16, 1, 0.3, 1];

/**
 * Animate a number from 0 → `target` once it scrolls into view. Returns the ref to
 * attach and the live value to render. Reduced-motion jumps straight to the target.
 */
export function useCountUp(
  target: number,
  opts: { duration?: number; delay?: number } = {},
): { ref: React.RefObject<HTMLSpanElement | null>; value: number } {
  const ref = useRef<HTMLSpanElement | null>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });
  const reduce = useReducedMotion();
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!inView) return;
    if (reduce) {
      setValue(target);
      return;
    }
    const controls = animate(0, target, {
      duration: opts.duration ?? 1.2,
      delay: opts.delay ?? 0,
      ease: EASE_OUT_EXPO,
      onUpdate: (v) => setValue(v),
    });
    return () => controls.stop();
  }, [inView, reduce, target, opts.duration, opts.delay]);

  return { ref, value };
}

/** A count-up number formatted through `format`, with tabular figures so it never jitters. */
export function CountUp({
  value,
  format,
  className,
  delay,
}: {
  value: number;
  format: (n: number) => string;
  className?: string;
  delay?: number;
}) {
  const { ref, value: v } = useCountUp(value, { delay });
  return (
    <span ref={ref} className={className}>
      {format(v)}
    </span>
  );
}

/** Fade + rise a block into view once. No-op under reduced motion. */
export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: 0.45, delay, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  );
}
