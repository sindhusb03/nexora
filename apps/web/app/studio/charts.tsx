"use client";

import * as echarts from "echarts";
import { useEffect, useRef } from "react";

export function Chart({ option, label }: { readonly option: echarts.EChartsOption; readonly label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const chart = echarts.init(node, undefined, { renderer: "canvas" });
    chart.setOption(option);
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    };
  }, [option]);
  return <div ref={ref} className="nx-chart" role="img" aria-label={label} />;
}
