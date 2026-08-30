"use client";

import * as React from "react";

/**
 * Matches a CSS media query in React state.
 *
 * Needed because hiding a dialog's *content* with a responsive utility class
 * leaves its overlay mounted: the backdrop still covers and blurs the whole
 * page while the dialog itself is `display: none`. Whether a modal opens at
 * all is a rendering decision, not a styling one, so it has to be made in JS.
 *
 * Returns false during server rendering and the first client paint, so markup
 * matches and there is no hydration mismatch.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);

  return matches;
}
