//! 插件执行的内存预算（thread-local 限流分配器）。
//!
//! ## 为什么需要这个
//!
//! Boa **没有任何堆/分配预算 API**（已核实 0.21.1 与最新 0.22.0 的 `RuntimeLimits`
//! 都只有 loop / stack / recursion / backtrace 四项；`boa_gc` 也无上限；上游那个
//! 「给不可信代码设运行时限制」的 issue 正文压根没提内存）。也就是说：
//! **Boa 侧设不了内存上限**，而插件可以一句 `"x".repeat(1e9)` 把整个应用拖死。
//! 详见 `docs/plans/2026-09-10-plugin-evolution-plan.md` §3.11。
//!
//! ## 为什么是「超预算 panic」而不是「返回 null」
//!
//! stable Rust + 链接 std 时，不可失败分配失败会走 `std::alloc::handle_alloc_error`
//! → **打印后 abort 进程，不 unwind**；能定制这个行为的 `set_alloc_error_hook`
//! 是 nightly-only 实验 API。所以「限流分配器返回 null」＝**确定性弄死应用**，
//! 是错解。
//!
//! 正解是**在分配器里 panic**：panic 会 unwind 插件线程，被
//! [`crate::plugins`] 的 `with_timeout` 捕获并转成一条干净的错误，
//! 应用存活。这依赖三件已核实的事实：
//!   1. 仓库 `Cargo.toml` 没有 `[profile]` 覆盖 → 默认 `panic = "unwind"`；
//!   2. 插件执行本来就是「一次性」的（每次调用新建 `Context`，用完即弃），
//!      所以 unwind 出来把上下文整个丢掉是安全的；
//!   3. 插件线程执行期间不持有应用锁（DB 锁在跑 JS 前已释放）。
//!
//! ## 计费口径
//!
//! 记 **峰值活跃字节**（`alloc` 加、`dealloc` 减、`realloc` 只算增量），
//! 而不是累计分配量 —— 否则一个老实做 GC 的插件会因为"总共分配过很多次"
//! 被误杀。只有被 [`with_budget`] 武装的线程计费；其它线程只多一次 TLS 读。

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

/// 单次插件调用的分配预算（峰值活跃字节）。
///
/// 64 MiB 对"读一页正文 + 拼字符串"这类真实插件极其宽裕，同时把
/// `new Array(1e7).fill(0)`（约 160 MB）这类炸弹挡在门外。
/// 后续能力扩容（M11.7，比如跨页检索）若确实需要更多，**在这里调**，
/// 而不是把预算取消。
pub const PLUGIN_ALLOC_BUDGET: usize = 64 * 1024 * 1024;

/// 超预算时额外放行的余量。
///
/// panic 载荷、错误信息与 unwind 过程本身也要分配；一点余量都不给，
/// 第一次 panic 期间的下一次分配就会再次失败 → abort，反而把进程弄死。
const GRACE: usize = 256 * 1024;

/// 超预算时 panic 的载荷标记。
///
/// 用**字面量** `panic!`（见 [`charge`]）而不是 `panic!("{}", …)`：
/// 字面量 panic 的载荷是 `&'static str`，不额外格式化；外层据此区分
/// 「内存超预算」与「引擎内部 panic」，给出不同的用户可见文案。
pub const BUDGET_PANIC: &str = "__shuyonote_plugin_alloc_budget__";

thread_local! {
    /// 0 = 该线程未武装（不计费、不受限）。
    ///
    /// 一律用 `const` 初始化：保证访问 TLS **本身不会触发惰性初始化或析构注册**
    /// （那会再进分配器、自递归）。`Cell<usize>` 无 `Drop`，线程析构期访问也安全。
    static LIMIT: Cell<usize> = const { Cell::new(0) };
    static USED: Cell<usize> = const { Cell::new(0) };
}

#[inline]
fn charge(bytes: usize) {
    LIMIT.with(|limit| {
        let limit_now = limit.get();
        if limit_now == 0 {
            return; // 常规线程：一次 TLS 读就返回
        }
        USED.with(|used| {
            let next = used.get().saturating_add(bytes);
            used.set(next);
            if next > limit_now {
                // 先放行余量、再 panic：让 panic/unwind 自身的分配能成功。
                limit.set(next.saturating_add(GRACE));
                // 必须是字面量形式，载荷才是 `&'static str`（见 BUDGET_PANIC 注释）。
                panic!("__shuyonote_plugin_alloc_budget__");
            }
        });
    });
}

#[inline]
fn refund(bytes: usize) {
    LIMIT.with(|limit| {
        if limit.get() == 0 {
            return;
        }
        USED.with(|used| used.set(used.get().saturating_sub(bytes)));
    });
}

/// 全局分配器：普通线程行为与 `System` 完全一致，只有被 [`with_budget`]
/// 武装过的线程才计费并受上限约束。
pub struct BudgetedAllocator;

unsafe impl GlobalAlloc for BudgetedAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        charge(layout.size());
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        refund(layout.size());
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        charge(layout.size());
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // 只对增量计费 / 对缩减退款，避免把 realloc 重复计一遍。
        if new_size > layout.size() {
            charge(new_size - layout.size());
        } else {
            refund(layout.size() - new_size);
        }
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static ALLOCATOR: BudgetedAllocator = BudgetedAllocator;

/// 在 `limit` 字节的预算下运行 `f`；超预算时从分配器内部 panic。
///
/// 可嵌套：`limit` / `used` 用 RAII 守卫恢复，`f` panic 时也会恢复。
pub fn with_budget<T>(limit: usize, f: impl FnOnce() -> T) -> T {
    struct Restore {
        limit: usize,
        used: usize,
    }
    impl Drop for Restore {
        fn drop(&mut self) {
            LIMIT.with(|l| l.set(self.limit));
            USED.with(|u| u.set(self.used));
        }
    }
    let _restore = Restore {
        limit: LIMIT.with(|l| l.replace(limit)),
        used: USED.with(|u| u.replace(0)),
    };
    f()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unarmed_threads_are_not_limited() {
        // 没武装就不该受任何影响：分配远超预算的量也必须成功。
        let v: Vec<u8> = vec![7u8; PLUGIN_ALLOC_BUDGET + 1024];
        assert_eq!(v.len(), PLUGIN_ALLOC_BUDGET + 1024);
    }

    #[test]
    fn over_budget_panics_so_it_can_be_caught_instead_of_aborting() {
        // 这是整个方案的关键性质：超预算**可被 catch_unwind 捕获**（= 能 unwind），
        // 而不是 abort 进程。这条测试若变成 abort，说明 panic 策略或分配器坏了。
        let res = std::panic::catch_unwind(|| {
            with_budget(1 << 20, || {
                let v: Vec<u8> = vec![0u8; 4 << 20]; // 4 MiB > 1 MiB 预算
                v.len()
            })
        });
        let payload = res.expect_err("超预算应当 panic");
        let msg = payload
            .downcast_ref::<&str>()
            .copied()
            .unwrap_or("<非 &str 载荷>");
        assert_eq!(msg, BUDGET_PANIC, "应当用约定标记 panic，便于上层区分文案");
    }

    #[test]
    fn budget_is_restored_after_a_trip() {
        // 超预算 panic 之后（守卫 drop 已恢复），同线程再分配大块内存必须恢复正常。
        let _ = std::panic::catch_unwind(|| {
            with_budget(1 << 20, || vec![0u8; 4 << 20].len())
        });
        let v: Vec<u8> = vec![0u8; 4 << 20];
        assert_eq!(v.len(), 4 << 20, "预算没有被恢复，会污染后续普通分配");
    }

    #[test]
    fn within_budget_work_is_unaffected() {
        let n = with_budget(PLUGIN_ALLOC_BUDGET, || {
            let v: Vec<u8> = vec![5u8; 1 << 20];
            v.iter().map(|b| *b as usize).sum::<usize>()
        });
        assert_eq!(n, (1 << 20) * 5);
    }

    #[test]
    fn freeing_memory_makes_room_again() {
        // 峰值口径：分配 → 释放 → 再分配，不应因为"累计分配过"而误杀。
        with_budget(2 << 20, || {
            for _ in 0..8 {
                let v: Vec<u8> = vec![0u8; 1 << 20]; // 1 MiB，反复分配共 8 MiB
                assert_eq!(v.len(), 1 << 20);
            }
        });
    }
}
