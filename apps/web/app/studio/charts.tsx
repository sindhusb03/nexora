"use client";

import * as echarts from "echarts";
import { useEffect, useRef } from "react";

export function Chart({
  option,
  label,
  onPoint,
}: {
  readonly option: echarts.EChartsOption;
  readonly label: string;
  readonly onPoint?: (index: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onPointRef = useRef(onPoint);
  onPointRef.current = onPoint;
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const chart = echarts.init(node, undefined, { renderer: "canvas" });
    chart.setOption({ animation: false, ...option }, true);
    chart.on("click", (params) => {
      if (typeof params.dataIndex === "number") onPointRef.current?.(params.dataIndex);
    });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(node);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [option]);
  return <div ref={ref} className="nx-chart" role="img" aria-label={label} />;
}
