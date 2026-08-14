/**
 * 可控的 IntersectionObserver 替身(测试专用,vitest 不收集非 *.test.ts)。
 *
 * happy-dom 自带的 IO 永远不会回调,而"元素滚出视口"正是
 * `useDeferredAutoCollapse` 这道门唯一需要外界告诉它的事实 —— 所以测试要能
 * 亲手驱动它。composable 的状态机测试和 ProcessRail / StepsPanel 的整合测试
 * 共用这一份,别各写各的。
 */

export class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = []

  readonly targets: Element[] = []
  disconnected = false

  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    MockIntersectionObserver.instances.push(this)
  }

  observe(element: Element): void {
    this.targets.push(element)
  }

  unobserve(): void {}

  disconnect(): void {
    this.disconnected = true
  }

  /** 让所有已观察的目标同时报告一次相交状态。 */
  emit(isIntersecting: boolean): void {
    this.callback(
      this.targets.map(target => ({ target, isIntersecting }) as unknown as IntersectionObserverEntry),
      this as unknown as IntersectionObserver,
    )
  }

  static reset(): void {
    MockIntersectionObserver.instances = []
  }

  static get last(): MockIntersectionObserver {
    return MockIntersectionObserver.instances[MockIntersectionObserver.instances.length - 1]
  }

  /** 最近一次挂起是否已经断开监听(挂起不得泄漏)。 */
  static allDisconnected(): boolean {
    return MockIntersectionObserver.instances.every(observer => observer.disconnected)
  }
}

/** 只有 top/bottom 是真数据的 DOMRect —— 这道门只看纵向几何。 */
export function verticalRect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 0,
    width: 0,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect
}
