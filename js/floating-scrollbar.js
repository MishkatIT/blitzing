(() => {
    if (window.__floatingScrollbarInitialized) {
        return;
    }
    window.__floatingScrollbarInitialized = true;

    const rail = document.createElement('div');
    rail.className = 'floating-scrollbar';

    const thumb = document.createElement('div');
    thumb.className = 'floating-scrollbar-thumb';
    rail.appendChild(thumb);

    document.body.appendChild(rail);

    let dragging = false;
    let dragOffset = 0;

    const getScrollMetrics = () => {
        const doc = document.documentElement;
        const maxScroll = Math.max(0, doc.scrollHeight - window.innerHeight);
        return {
            maxScroll,
            scrollTop: window.scrollY || doc.scrollTop || 0,
            viewHeight: window.innerHeight,
            fullHeight: doc.scrollHeight,
            trackHeight: rail.clientHeight
        };
    };

    const updateThumb = () => {
        const { maxScroll, scrollTop, viewHeight, fullHeight, trackHeight } = getScrollMetrics();
        if (trackHeight <= 0) {
            return;
        }

        if (maxScroll <= 0 || fullHeight <= viewHeight + 1) {
            thumb.style.top = '0px';
            thumb.style.height = `${trackHeight}px`;
            rail.classList.add('is-static');
            return;
        }

        rail.classList.remove('is-static');

        const thumbHeight = Math.max(36, (viewHeight / fullHeight) * trackHeight);
        const travel = Math.max(1, trackHeight - thumbHeight);
        const ratio = scrollTop / maxScroll;

        thumb.style.height = `${thumbHeight}px`;
        thumb.style.top = `${travel * ratio}px`;
    };

    const scrollToThumbPosition = (thumbTop) => {
        const { maxScroll, trackHeight } = getScrollMetrics();
        const thumbHeight = thumb.offsetHeight;
        const travel = Math.max(1, trackHeight - thumbHeight);
        const boundedTop = Math.max(0, Math.min(thumbTop, travel));
        const ratio = boundedTop / travel;
        window.scrollTo({ top: ratio * maxScroll, behavior: 'auto' });
    };

    thumb.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        dragging = true;
        rail.classList.add('is-dragging');
        dragOffset = event.clientY - thumb.getBoundingClientRect().top;
        thumb.setPointerCapture(event.pointerId);
    });

    thumb.addEventListener('pointermove', (event) => {
        if (!dragging) {
            return;
        }
        const railTop = rail.getBoundingClientRect().top;
        scrollToThumbPosition(event.clientY - railTop - dragOffset);
    });

    const endDrag = (event) => {
        if (!dragging) {
            return;
        }
        dragging = false;
        rail.classList.remove('is-dragging');
        if (event.pointerId !== undefined) {
            thumb.releasePointerCapture(event.pointerId);
        }
    };

    thumb.addEventListener('pointerup', endDrag);
    thumb.addEventListener('pointercancel', endDrag);

    rail.addEventListener('pointerdown', (event) => {
        if (event.target === thumb) {
            return;
        }
        const railTop = rail.getBoundingClientRect().top;
        const centeredTop = event.clientY - railTop - thumb.offsetHeight / 2;
        scrollToThumbPosition(centeredTop);
        updateThumb();
    });

    window.addEventListener('scroll', updateThumb, { passive: true });
    window.addEventListener('resize', updateThumb);

    if (window.ResizeObserver) {
        const resizeObserver = new ResizeObserver(updateThumb);
        resizeObserver.observe(document.documentElement);
        resizeObserver.observe(document.body);
    }

    updateThumb();
    setTimeout(updateThumb, 0);
})();
