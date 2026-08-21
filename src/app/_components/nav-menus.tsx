"use client";

/**
 * The nav's dropdown menus.
 *
 * ## Why this replaced `<details>`
 *
 * The previous version used `<details>`/`<summary>`, chosen so the menus needed no JavaScript
 * and could not break on hydration. The documented trade-off was that a menu stays open until
 * dismissed, judged acceptable for an internal tool.
 *
 * It was not acceptable. Because each `<details>` is independent, opening a second menu leaves
 * the first open, and they are absolutely positioned — so four open menus overlap into an
 * unreadable stack covering the page. Nothing closes them but going back and clicking each
 * summary again. A menu you have to clean up after is worse than a menu that needs JavaScript.
 *
 * ## What replaced it, and what was kept
 *
 * A button with `aria-expanded` plus a panel, which is the standard disclosure pattern. State
 * lives in one component, so only one menu can be open by construction rather than by
 * cooperation.
 *
 * The original accessibility objection still holds and is still honoured: a hover-only CSS
 * menu using `visibility: hidden` keeps its links in the DOM but out of the tab order, so a
 * keyboard user can never reach them. Here the panel is not rendered at all when closed and
 * fully tabbable when open, and the button toggles on Enter or Space natively. Escape closes
 * and returns focus to the button. Clicking outside closes.
 *
 * ## Two details that make hover menus feel broken when omitted
 *
 * **The close delay.** Moving the pointer diagonally from the button toward a link briefly
 * leaves the container, and closing instantly means the menu vanishes as you reach for it.
 * A short delay before closing absorbs that.
 *
 * **Hover gating.** On a touch device there is no hover, and a `pointerenter` that fires on tap
 * would open the menu only for the click to immediately close it again. The event's own
 * `pointerType` says which it is, so each event is judged on its own rather than on a
 * device-wide media query read once at mount — which was both less accurate and a `setState`
 * inside an effect, i.e. a cascading render on every page load.
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export interface NavMenuLink {
  href: string;
  label: string;
}

export interface NavMenuGroup {
  label: string;
  links: NavMenuLink[];
}

/** Long enough to cross the gap between button and panel, short enough not to feel sticky. */
const CLOSE_DELAY_MS = 180;

const ITEM_CLASS =
  "rounded-lg px-2.5 py-1.5 text-sm text-neutral-600 transition hover:bg-neutral-100 " +
  "hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 " +
  "dark:hover:text-neutral-100";

export function NavMenus({ groups }: { groups: NavMenuGroup[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navRef = useRef<HTMLElement | null>(null);

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(null), CLOSE_DELAY_MS);
  };

  useEffect(() => cancelClose, []);

  useEffect(() => {
    if (open === null) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(null);
      // Focus goes back to the button that opened it, not to the top of the page — otherwise
      // Escape costs a keyboard user their place in the nav.
      navRef.current
        ?.querySelector<HTMLButtonElement>(`[data-menu="${CSS.escape(open)}"]`)
        ?.focus();
    };

    const onPointerDown = (e: PointerEvent) => {
      if (!navRef.current?.contains(e.target as Node)) setOpen(null);
    };

    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <nav
      ref={navRef}
      className="flex flex-wrap items-center gap-1"
      // Close when focus leaves the nav entirely — a keyboard user tabbing past the last link
      // should not leave a panel hanging open behind the page.
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(null);
      }}
    >
      {groups.map((g) => {
        // A group with one link renders bare. A disclosure control around a single item is
        // friction with nothing behind it, and it happens naturally whenever a role can see
        // only one page in a group — so this is a real case, not a stylistic one.
        if (g.links.length === 1) {
          return (
            <Link key={g.label} href={g.links[0].href} className={ITEM_CLASS}>
              {g.label}
            </Link>
          );
        }

        const isOpen = open === g.label;

        return (
          <div
            key={g.label}
            className="relative"
            // `pointerType` rather than a device check: a tap reports "touch", where opening
            // on enter would fight the click that follows it.
            onPointerEnter={(e) => {
              if (e.pointerType !== "mouse") return;
              cancelClose();
              setOpen(g.label);
            }}
            onPointerLeave={(e) => {
              if (e.pointerType !== "mouse") return;
              scheduleClose();
            }}
          >
            <button
              type="button"
              data-menu={g.label}
              aria-expanded={isOpen}
              aria-haspopup="true"
              onClick={() => setOpen(isOpen ? null : g.label)}
              className={`${ITEM_CLASS} cursor-pointer whitespace-nowrap ${
                isOpen ? "bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100" : ""
              }`}
            >
              {g.label}
              <span aria-hidden className="ml-1 text-[10px] text-neutral-400">
                ▾
              </span>
            </button>

            {isOpen ? (
              // pt-1 rather than mt-1: the gap has to be INSIDE the hoverable area, or the
              // pointer leaves the container while crossing it and the menu closes underneath
              // the cursor.
              <div className="absolute left-0 top-full z-20 pt-1">
                <div className="min-w-[14rem] rounded-xl border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
                  {g.links.map((l) => (
                    <Link
                      key={l.href}
                      href={l.href}
                      onClick={() => setOpen(null)}
                      className="block rounded-lg px-3 py-2 text-sm text-neutral-700 transition hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
                    >
                      {l.label}
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}
