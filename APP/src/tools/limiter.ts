/** 共享最小间隔限速器（0.4.4）：替代 amap/baidu 各自写死的 MIN_INTERVAL。
 * 串行化等待——并发调用排队依次通过，保证全局任意两次放行的间隔 ≥ getIntervalMs()。
 * 间隔在【每次调用时】动态读取（设置热生效，与 settings.ts 的 resolve* 哲学一致）；
 * 返回 0/负数表示不限速。 */
export function createMinInterval(getIntervalMs: () => number) {
  let last = 0;
  let chain: Promise<void> = Promise.resolve();
  return async function throttle(): Promise<void> {
    const run = chain.then(async () => {
      const interval = getIntervalMs();
      if (interval > 0) {
        const wait = interval - (Date.now() - last);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
      }
      last = Date.now();
    });
    chain = run.catch(() => { /* 排队链不断 */ });
    await run;
  };
}
