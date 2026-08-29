/**
 * Svelte action for column resize handles
 *
 * Usage:
 * <div class="resize-handle" use:columnResize={{ onResize, onResizeEnd, minWidth }} />
 */

export interface ColumnResizeParams {
	onResize: (width: number) => void;
	onResizeEnd: (width: number) => void;
	minWidth?: number;
}

export function columnResize(node: HTMLElement, params: ColumnResizeParams) {
	let startX: number;
	let startWidth: number;
	let currentWidth: number;
	let currentParams = params;
	let isLeftHandle = false;

	function startResize(clientX: number) {
		const parent = node.parentElement;
		if (!parent) return false;
		isLeftHandle = node.classList.contains('resize-handle-left');
		startX = clientX;
		startWidth = parent.offsetWidth;
		currentWidth = startWidth;
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';
		return true;
	}

	function onPointerDown(e: PointerEvent) {
		e.preventDefault();
		e.stopPropagation();
		if (!startResize(e.clientX)) return;
		node.setPointerCapture(e.pointerId);
		node.addEventListener('pointermove', onPointerMove);
		node.addEventListener('pointerup', onPointerUp, { once: true });
		node.addEventListener('pointercancel', onPointerUp, { once: true });
	}

	function onPointerMove(e: PointerEvent) {
		let delta = e.clientX - startX;
		// For left-side handles, invert the delta (drag left = wider)
		if (isLeftHandle) {
			delta = -delta;
		}
		currentWidth = Math.max(currentParams.minWidth ?? 50, startWidth + delta);
		currentParams.onResize(currentWidth);
	}

	function finishResize() {
		document.body.style.cursor = '';
		document.body.style.userSelect = '';
		currentParams.onResizeEnd(currentWidth);
	}

	function onPointerUp(e: PointerEvent) {
		if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId);
		node.removeEventListener('pointermove', onPointerMove);
		finishResize();
	}

	function onKeyDown(e: KeyboardEvent) {
		if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
		e.preventDefault();
		e.stopPropagation();
		const parent = node.parentElement;
		if (!parent) return;
		const minWidth = currentParams.minWidth ?? 50;
		const maxWidth = Math.max(minWidth, parent.offsetWidth + 1000);
		let width = parent.offsetWidth;
		if (e.key === 'Home') width = minWidth;
		else if (e.key === 'End') width = maxWidth;
		else {
			const delta = e.key === 'ArrowRight' ? 10 : -10;
			width = isLeftHandle ? width - delta : width + delta;
		}
		const nextWidth = Math.max(minWidth, width);
		currentParams.onResize(nextWidth);
		currentParams.onResizeEnd(nextWidth);
	}

	node.addEventListener('pointerdown', onPointerDown);
	node.addEventListener('keydown', onKeyDown);

	return {
		update(newParams: ColumnResizeParams) {
			currentParams = newParams;
		},
		destroy() {
			node.removeEventListener('pointerdown', onPointerDown);
			node.removeEventListener('keydown', onKeyDown);
			node.removeEventListener('pointermove', onPointerMove);
		}
	};
}
