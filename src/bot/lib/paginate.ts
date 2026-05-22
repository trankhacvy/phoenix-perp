import type { InlineKeyboard } from "grammy";

export interface Paginated<T> {
  items: T[];
  page: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
}

export function paginate<T>(all: T[], page: number, pageSize: number): Paginated<T> {
  const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * pageSize;
  return {
    items: all.slice(start, start + pageSize),
    page: safePage,
    totalPages,
    hasPrev: safePage > 0,
    hasNext: safePage < totalPages - 1,
  };
}

export function addPaginationRow(
  kb: InlineKeyboard,
  callbackPrefix: string,
  page: number,
  totalPages: number,
): void {
  if (totalPages <= 1) return;
  if (page > 0) kb.text("← Prev", `${callbackPrefix}:${page - 1}`);
  kb.text(`${page + 1} / ${totalPages}`, "noop");
  if (page < totalPages - 1) kb.text("Next →", `${callbackPrefix}:${page + 1}`);
  kb.row();
}
