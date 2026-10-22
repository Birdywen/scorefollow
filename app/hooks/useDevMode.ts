"use client";

import { useEffect, useState } from "react";

/** Developer tools show only with ?dev=1 in the address. False on the server and the first render. */
export function useDevMode(): boolean {
  const [dev, setDev] = useState(false);
  useEffect(() => {
    try { setDev(new URLSearchParams(window.location.search).get("dev") === "1"); } catch { /* keep hidden */ }
  }, []);
  return dev;
}
