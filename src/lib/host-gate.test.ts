import { describe, expect, it } from 'vitest';
import { createHostGate, hostOf } from './host-gate';

/**
 * host 闸门单测：同一 host 的并发上限、不同 host 互不影响、
 * 排队 FIFO、释放幂等、取消语义、空闲清理。
 */

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('hostOf', () => {
  it('取 host（含端口），不同路径同 host 同闸门', () => {
    expect(hostOf('https://api.example.com/a/b?c=1')).toBe('api.example.com');
    expect(hostOf('https://api.example.com:8443/x')).toBe('api.example.com:8443');
  });

  it('脏 URL 退化为原始字符串而不是抛错', () => {
    expect(hostOf('not-a-url')).toBe('not-a-url');
  });
});

describe('createHostGate', () => {
  it('同一 host 的门额用尽后要排队，释放一个放行一个，顺序是 FIFO', async () => {
    const gate = createHostGate(2);
    const order: string[] = [];

    const r1 = await gate.acquire('https://a.test/1');
    const r2 = await gate.acquire('https://a.test/2');
    expect(gate.activeHosts()).toBe(1);

    const p3 = gate.acquire('https://a.test/3').then((release) => {
      order.push('third');
      return release;
    });
    const p4 = gate.acquire('https://a.test/4').then((release) => {
      order.push('fourth');
      return release;
    });

    await tick();
    expect(order).toEqual([]);

    r1();
    const r3 = await p3;
    expect(order).toEqual(['third']);

    r2();
    const r4 = await p4;
    expect(order).toEqual(['third', 'fourth']);

    r3();
    r4();
    // 全部释放后闸门应当被清理，不留无界增长的 Map
    expect(gate.activeHosts()).toBe(0);
  });

  it('不同 host 各自独立，一个 host 排队不影响另一个', async () => {
    const gate = createHostGate(1);
    const releaseA = await gate.acquire('https://a.test/v');
    expect(gate.activeHosts()).toBe(1);

    const pending = gate.acquire('https://a.test/again');
    const releaseB = await gate.acquire('https://b.test/v');
    expect(releaseB).toBeTypeOf('function');
    expect(gate.activeHosts()).toBe(2);

    releaseB();
    releaseA();
    (await pending)();
    expect(gate.activeHosts()).toBe(0);
  });

  it('释放是幂等的：重复调用不会多还名额', async () => {
    const gate = createHostGate(1);
    const release = await gate.acquire('https://a.test/x');
    release();
    release();
    // 若重复释放把 active 减成 -1，这里就能再拿到两个名额
    const r1 = await gate.acquire('https://a.test/y');
    expect(r1).toBeTypeOf('function');
    const blocked = gate.acquire('https://a.test/z');
    let granted = false;
    void blocked.then(() => {
      granted = true;
    });
    await tick();
    expect(granted).toBe(false);
    r1();
    (await blocked)();
  });

  it('run 在 fn 抛错时也释放名额', async () => {
    const gate = createHostGate(1);
    await expect(
      gate.run('https://a.test/v', async () => {
        throw new Error('上游炸了');
      })
    ).rejects.toThrow('上游炸了');
    expect(gate.activeHosts()).toBe(0);
    // 名额确实还回来了
    const release = await gate.acquire('https://a.test/v');
    release();
  });

  it('已经取消的 signal 直接拒绝，不占名额也不进队列', async () => {
    const gate = createHostGate(1);
    const controller = new AbortController();
    controller.abort();
    await expect(gate.acquire('https://a.test/v', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(gate.activeHosts()).toBe(0);
  });

  it('排队中被取消：从队列里摘掉，不放行也不泄漏名额', async () => {
    const gate = createHostGate(1);
    const release = await gate.acquire('https://a.test/v');
    const controller = new AbortController();
    const waiting = gate.acquire('https://a.test/v', controller.signal);
    await tick();
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });

    // 取消的等待者不该被 release 误放行，名额回到空闲
    release();
    expect(gate.activeHosts()).toBe(0);
  });

  it('非法并发参数退化为 1，不当成无限制', async () => {
    const gate = createHostGate(0);
    const r1 = await gate.acquire('https://a.test/v');
    let granted = false;
    void gate.acquire('https://a.test/v').then(() => {
      granted = true;
    });
    await tick();
    expect(granted).toBe(false);
    r1();
  });

  it('真实并发压测：20 个任务在 limit=3 时同时在途数不超过 3', async () => {
    const gate = createHostGate(3);
    let active = 0;
    let peak = 0;
    const completed: number[] = [];
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        gate.run('https://a.test/v', async () => {
          active++;
          peak = Math.max(peak, active);
          await tick();
          active--;
          completed.push(i);
        })
      )
    );
    expect(peak).toBe(3);
    expect(completed).toHaveLength(20);
    expect(gate.activeHosts()).toBe(0);
  });
});
