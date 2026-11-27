/** Bounded interval history. Recovery never erases an affected interval. */
export class CaptureCoverageGaps {
  private readonly gaps: Array<{ from: number; through: number; code: string }> = [];
  add(code: string, from: number, through = from) {
    this.gaps.push({ code, from, through: Math.max(from, through) });
    if (this.gaps.length > 512) {
      const a = this.gaps.shift()!, b = this.gaps.shift()!;
      this.gaps.unshift({ code: "coverage_history_compacted", from: Math.min(a.from, b.from), through: Math.max(a.through, b.through) });
    }
  }
  within(from: number, through: number): string[] {
    return [...new Set(this.gaps.filter(gap => gap.from <= through && gap.through >= from).map(gap => gap.code))];
  }
}
