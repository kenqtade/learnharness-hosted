"use client";

import { cloneElement, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactElement, type RefObject } from "react";
import { createPortal } from "react-dom";
import { PaperclipIcon } from "lucide-react";
import { directoryReferencePath, quoteFilePath } from "@/src/core";
import { Hint } from "@/components/ui/hint";
import { useMe } from "@/components/account/use-me";
import { INSERT_FILE_PATHS_EVENT } from "@/components/path-input";
import { BROWSER_NOTICE } from "@/components/file-path-drop-zone";
import { InteractionLayerOwner, useInteractionLayer, useInteractionLayers, useOptionalInteractionLayers } from "./interaction-layers";
import { INTERACTION_LAYER_Z_BASE } from "./host-dialog";
import { isInteractionScopeEligible } from "./plugin-input-focus";

/** Picked files → the rooted paths an editor chips (issue #285), via the
 *  desktop bridge. Same validity rule as drops: a file without a usable
 *  path is skipped, never guessed. */
export function pathsForFiles(files: Iterable<File>, resolve: (file: File) => string): { paths: string[]; skipped: number } {
	const paths: string[] = [];
	let skipped = 0;
	for (const file of files) {
		try {
			const path = resolve(file);
			quoteFilePath(path);
			paths.push(path);
		} catch { skipped++; }
	}
	return { paths, skipped };
}

/** Center over the paperclip, but clear the whole visible composer, not just
 * its bottom-aligned button. Clamp horizontally and scroll above the dock. */
export function attachmentPopupPlacement(button: { left: number; right: number }, composer: { top: number }, popupWidth: number, viewport: { width: number; height: number }) {
	const edge = 8;
	const gap = 4;
	const maxWidth = Math.max(0, viewport.width - edge * 2);
	const width = Math.min(popupWidth, maxWidth);
	return {
		left: Math.max(edge, Math.min((button.left + button.right - width) / 2, viewport.width - edge - width)),
		bottom: viewport.height - composer.top + gap,
		maxWidth,
		maxHeight: Math.max(0, Math.min(viewport.height * 0.6, composer.top - gap - edge)),
	};
}

const noSubscribe = () => () => {};
/** The bridge is fixed for the window's life; the server render is always
 *  the browser case, so hydration never mismatches. */
function useDesktopPaths(): boolean {
	return useSyncExternalStore(noSubscribe, () => Boolean(window.lh?.getPathForFile), () => false);
}

/** HOSTED FORK — the browser's upload cap (src/server/uploads.ts enforces
 *  the same number; Convex refuses larger files too). */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function uploadTooLarge(file: File): string {
	const mb = (file.size / (1024 * 1024)).toFixed(1);
	return `${file.name} is ${mb} MB. Files can be up to 25 MB.`;
}

async function uploadError(response: Response, fallback: string): Promise<string> {
	try {
		const body = (await response.json()) as { error?: unknown };
		if (typeof body.error === "string" && body.error) return body.error;
	} catch {
		// non-JSON error body
	}
	return fallback;
}

/** The choice menu owns Escape with the same layer law as MenuShell, while
 * retaining its paperclip/composer-specific geometry. Mount separately so a
 * closed button remains safe in standalone/static renders. Notices are passive. */
function AttachmentPopup({ anchorRef, rootRef, open, close, children }: {
	anchorRef: RefObject<HTMLButtonElement | null>; rootRef: RefObject<HTMLDivElement | null>;
	open: boolean; close(): void; children: ReactElement<{ style?: CSSProperties }>;
}) {
	const controller = useInteractionLayers();
	const owner = controller.ownerOf(anchorRef.current);
	const layer = useInteractionLayer({ kind: "popup", enabled: open, rootRef, anchorRef, ownerId: owner?.id,
		onClose: reason => {
			close();
			if (reason === "escape" && controller.isPopupOrigin(anchorRef.current)) anchorRef.current?.focus();
			return "closed";
		},
	});
	const portal = controller.getPortalContainer(anchorRef.current, owner?.id);
	if (!portal) return null;
	return createPortal(<InteractionLayerOwner.Provider value={open ? layer.id : owner?.id ?? null}>
		{cloneElement(children, { style: { ...children.props.style, zIndex: INTERACTION_LAYER_Z_BASE + (open ? layer.order : owner?.order ?? 0) } })}
	</InteractionLayerOwner.Provider>, portal);
}

/**
 * The attach button (issue #285): the picker's twin of a file drop — files
 * stay where they are and only their quoted paths enter the draft, at the
 * caret of `editorRef` (a PathInput root). Any file type; the agent reads
 * what it can. Desktop only: a browser File has no local path, so there the
 * button explains instead (the drop zone's notice). The separate native
 * folder choice returns the directory itself, including an empty directory.
 * aria-disabled, not disabled, so the tooltip still shows.
 */
export function AttachFilesButton({ editorRef }: { editorRef: React.RefObject<HTMLDivElement | null> }) {
	const controller = useOptionalInteractionLayers();
	const pickerRef = useRef<HTMLInputElement>(null);
	const desktop = useDesktopPaths();
	const me = useMe();
	// HOSTED FORK: no desktop bridge, but the server offers uploads.
	const hostedUploads = !desktop && me?.uploads === true;
	const uploading = useRef(false);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const popupRef = useRef<HTMLDivElement>(null);
	const choosingFolder = useRef(false);
	const [open, setOpen] = useState(false);
	const [notice, setNotice] = useState("");
	const [placement, setPlacement] = useState<ReturnType<typeof attachmentPopupPlacement> | null>(null);
	const positioned = placement !== null;
	// Like MenuShell, portal to body with viewport-capped, reanchored placement.
	// The production chat/new-session docks deliberately clip their children.
	// Keep notice focus passive; only the choice menu takes keyboard focus.
	useLayoutEffect(() => {
		if (!open && !notice) { setPlacement(null); return; }
		const button = buttonRef.current;
		const popup = popupRef.current;
		if (!button || !popup) return;
		const composer = button.closest<HTMLElement>("[data-attachment-composer]") ?? button;
		const place = () => {
			setPlacement(attachmentPopupPlacement(button.getBoundingClientRect(), composer.getBoundingClientRect(),
				popup.getBoundingClientRect().width, { width: window.innerWidth, height: window.innerHeight }));
		};
		place();
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
		observer?.observe(composer);
		observer?.observe(popup);
		window.addEventListener("scroll", place, true);
		window.addEventListener("resize", place);
		return () => { observer?.disconnect(); window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
	}, [open, notice]);
	useEffect(() => { if (open && positioned && isInteractionScopeEligible(popupRef.current, controller)) popupRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [open, positioned, controller]);
	useEffect(() => {
		if (!open && !notice) return;
		const dismissOutside = (event: PointerEvent) => {
			if (isInteractionScopeEligible(popupRef.current, controller) && event.target instanceof Node && !popupRef.current?.contains(event.target) && !buttonRef.current?.contains(event.target)) {
				setOpen(false); setNotice("");
			}
		};
		document.addEventListener("pointerdown", dismissOutside);
		return () => document.removeEventListener("pointerdown", dismissOutside);
	}, [open, notice, controller]);
	const chooseFolder = async () => {
		if (choosingFolder.current) return;
		const editor = editorRef.current;
		const choose = window.lh?.chooseAttachmentFolder;
		setOpen(false);
		setNotice("");
		if (!choose) { setNotice(BROWSER_NOTICE); return; }
		choosingFolder.current = true;
		try {
			const chosen = await choose();
			if (chosen === null) return; // Native cancellation leaves the draft intact.
			const path = directoryReferencePath(chosen);
			if (editor?.isConnected && editor === editorRef.current) editor.dispatchEvent(new CustomEvent(INSERT_FILE_PATHS_EVENT, { detail: [path] }));
		} catch { setNotice("Could not choose a folder. Try again."); }
		finally { choosingFolder.current = false; }
	};
	/** HOSTED FORK: upload each picked file straight to blob storage, then
	 *  index it and insert the returned path exactly like a desktop pick. */
	const uploadPicked = async (files: File[]) => {
		if (uploading.current) return;
		uploading.current = true;
		const paths: string[] = [];
		const problems: string[] = [];
		try {
			for (const [index, file] of files.entries()) {
				if (file.size > MAX_UPLOAD_BYTES) { problems.push(uploadTooLarge(file)); continue; }
				setNotice(`Uploading ${index + 1} of ${files.length}: ${file.name}`);
				try {
					const started = await fetch("/api/files", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ action: "upload-url" }),
					});
					if (!started.ok) throw new Error(await uploadError(started, "Could not start the upload."));
					const { url } = (await started.json()) as { url?: unknown };
					if (typeof url !== "string") throw new Error("Could not start the upload.");

					const uploaded = await fetch(url, {
						method: "POST",
						headers: { "Content-Type": file.type || "application/octet-stream" },
						body: file,
					});
					if (!uploaded.ok) throw new Error("Could not upload the file. Try again.");
					const { storageId } = (await uploaded.json()) as { storageId?: unknown };
					if (typeof storageId !== "string") throw new Error("The upload did not return a storage id.");

					const committed = await fetch("/api/files", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ action: "commit", storageId, name: file.name }),
					});
					if (!committed.ok) throw new Error(await uploadError(committed, "Could not save the upload."));
					const entry = (await committed.json()) as { path?: unknown };
					if (typeof entry.path !== "string") throw new Error("Could not save the upload.");
					paths.push(entry.path);
				} catch (error) {
					problems.push(`${file.name}: ${(error as Error).message}`);
				}
			}
		} finally {
			uploading.current = false;
			setNotice(problems.length ? problems.join(" ") : "");
		}
		const editor = editorRef.current;
		if (paths.length > 0 && editor?.isConnected && editor === editorRef.current) {
			editor.dispatchEvent(new CustomEvent(INSERT_FILE_PATHS_EVENT, { detail: paths }));
		}
	};
	return (
		<div className="relative shrink-0"
			onBlur={(event) => { if (isInteractionScopeEligible(popupRef.current ?? buttonRef.current, controller) && !event.currentTarget.contains(event.relatedTarget) && !popupRef.current?.contains(event.relatedTarget)) setOpen(false); }}>
			<input
				ref={pickerRef}
				type="file"
				multiple
				hidden
				data-testid="attach-files-input"
				onChange={(e) => {
					const files = Array.from(e.currentTarget.files ?? []);
					const resolve = window.lh?.getPathForFile;
					if (resolve) {
						const { paths } = pathsForFiles(files, resolve);
						if (paths.length > 0) editorRef.current?.dispatchEvent(new CustomEvent(INSERT_FILE_PATHS_EVENT, { detail: paths }));
					} else if (hostedUploads) {
						void uploadPicked(files);
					}
					e.currentTarget.value = ""; // allow re-picking the same file
				}}
			/>
			<Hint label={desktop ? "Attach files or a folder" : hostedUploads ? "Attach files" : BROWSER_NOTICE}>
				<button
					ref={buttonRef}
					type="button"
					aria-label="Attach files"
					aria-disabled={!desktop && !hostedUploads}
					aria-haspopup={desktop ? "menu" : undefined}
					aria-expanded={desktop ? open : undefined}
					data-testid="attach-files"
					onClick={() => {
						if (desktop) { setNotice(""); setOpen(!open); }
						else if (hostedUploads) { setNotice(""); pickerRef.current?.click(); }
					}}
					className="flex size-10 shrink-0 items-center justify-center rounded-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground"
				>
					<PaperclipIcon className="size-4" />
				</button>
			</Hint>
			{(open || notice) && <AttachmentPopup anchorRef={buttonRef} rootRef={popupRef} open={open} close={() => setOpen(false)}><div ref={popupRef} role={open ? "menu" : "status"}
				aria-label={open ? "Attach files or a folder" : undefined}
				data-testid="attachment-popup"
				style={{ position: "fixed", zIndex: 60, ...(placement ?? { left: 0, top: 0, visibility: "hidden" }), overflowY: "auto" }}
				className={open ? "w-max rounded-lg border bg-card p-1 shadow-lg" : "w-64 rounded-lg border bg-card p-2 text-xs text-muted-foreground shadow-lg"}
				onKeyDown={(event) => {
					const buttons = Array.from(popupRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
					const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
					const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? (index + 1) % buttons.length : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length : -1;
					if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); }
				}}>
				{open ? <>
					<button type="button" role="menuitem" className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent"
						onClick={() => { setOpen(false); pickerRef.current?.click(); }}>Files</button>
					<button type="button" role="menuitem" className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent"
						onClick={() => { void chooseFolder(); }}>Folder</button>
				</> : notice}
			</div></AttachmentPopup>}
		</div>
	);
}
