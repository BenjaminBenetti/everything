import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  AvatarAnimationLookup,
  AvatarAnimationProps,
} from "../interface/avatar-animation.js";

const AnimationContext = createContext<AvatarAnimationLookup | null>(null);

/** Supply registered effects without coupling consumers to a concrete registry. */
export function AvatarAnimationProvider({
  animations,
  children,
}: {
  animations: AvatarAnimationLookup;
  children: ReactNode;
}) {
  return (
    <AnimationContext.Provider value={animations}>
      {children}
    </AnimationContext.Provider>
  );
}

/** Play visible effects when motion is permitted, otherwise retaining an optional still pose. */
export function AvatarAnimation({
  name,
  ...props
}: AvatarAnimationProps & { name: string }) {
  const animations = useContext(AnimationContext);
  const Animation = animations?.get(name);
  const Still = animations?.getStill(name);
  const element = useRef<HTMLSpanElement>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!Animation || !element.current) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = typeof IntersectionObserver === "undefined";

    /** Select active playback only while visible and motion is permitted. */
    function updateActivity(): void {
      setActive(visible && !document.hidden && !motion.matches);
    }

    const observer =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver(([entry]) => {
            visible = entry?.isIntersecting ?? false;
            updateActivity();
          });
    observer?.observe(element.current);
    motion.addEventListener("change", updateActivity);
    document.addEventListener("visibilitychange", updateActivity);
    updateActivity();

    return () => {
      observer?.disconnect();
      motion.removeEventListener("change", updateActivity);
      document.removeEventListener("visibilitychange", updateActivity);
    };
  }, [Animation]);

  if (!Animation) return null;
  const Frame = active ? Animation : Still;
  return (
    <span
      ref={element}
      className="avatar-animation"
      data-avatar-animation={name}
      data-animation-active={active}
      aria-hidden="true"
    >
      {Frame && <Frame {...props} />}
    </span>
  );
}
