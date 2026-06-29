/**
 * ThinkingSpark — AI 在干活的「星芒」指示。8 条射线 scaleY 呼吸 + 逐条延迟,描边走主色。
 *
 * 两档:
 * - 思考(整个回合还没产出):大一点(~18px),站在最左,配「正在思考」。speed 慢。
 * - 处理(某一步正在跑):沉进工具行图标位(~13px,与其它工具图标同槽),替掉转圈。speed 快一档。
 *
 * 动画与降级在 globals.css 的 `.fa-spark`(prefers-reduced-motion 时静止)。
 */
const RAY_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];

export function ThinkingSpark({ size = 18, speed = "1.4s", animated = true }: { size?: number; speed?: string; animated?: boolean }) {
  return (
    <svg
      className={animated ? "fa-spark" : "fa-spark fa-spark-static"}
      width={size}
      height={size}
      viewBox="0 0 30 30"
      style={{ ["--fa-spark-speed" as string]: speed }}
      aria-hidden={true}
    >
      {RAY_ANGLES.map((deg, i) => (
        <g key={deg} transform={`rotate(${deg} 15 15)`}>
          {/* 射线更长更细(y2 4 / stroke 4)→ 舒展星芒,小尺寸下也不糊成圆点 */}
          <line className="ray" x1="15" y1="15" x2="15" y2="4" style={{ animationDelay: `${i * 0.1}s` }} />
        </g>
      ))}
    </svg>
  );
}
