(() => {
    function setupQuickNav(nav) {
        if (!nav || nav.dataset.overflowReady === '1') return;
        nav.dataset.overflowReady = '1';

        const account = nav.querySelector(':scope > .quick-nav-account');
        const navLinks = Array.from(nav.querySelectorAll(':scope > a.quick-nav-btn'));
        if (!navLinks.length) return;

        const more = document.createElement('div');
        more.className = 'quick-nav-more';
        more.innerHTML = `
            <button type="button" class="quick-nav-btn quick-nav-more-toggle" aria-haspopup="true" aria-expanded="false">
                More ▾
            </button>
            <div class="quick-nav-more-menu" role="menu"></div>
        `;

        if (account) {
            nav.insertBefore(more, account);
        } else {
            nav.appendChild(more);
        }

        const toggle = more.querySelector('.quick-nav-more-toggle');
        const menu = more.querySelector('.quick-nav-more-menu');
        let rafId = 0;
        let closeTimer = 0;

        function cancelClose() {
            if (closeTimer) {
                clearTimeout(closeTimer);
                closeTimer = 0;
            }
        }

        function closeMenu() {
            cancelClose();
            more.classList.remove('open');
            toggle.setAttribute('aria-expanded', 'false');
        }

        function closeMenuSoon() {
            cancelClose();
            closeTimer = setTimeout(() => {
                closeMenu();
            }, 240);
        }

        function openMenu() {
            if (!menu.children.length) return;
            cancelClose();
            more.classList.add('open');
            toggle.setAttribute('aria-expanded', 'true');
        }

        function placeAllBack() {
            navLinks.forEach((link) => {
                nav.insertBefore(link, more);
            });
            menu.innerHTML = '';
            more.style.display = 'none';
            closeMenu();
        }

        function directVisibleLinks() {
            return Array.from(nav.querySelectorAll(':scope > a.quick-nav-btn'));
        }

        function recalcOverflow() {
            placeAllBack();

            const links = directVisibleLinks();
            if (!links.length) return;

            while (nav.scrollWidth > nav.clientWidth && directVisibleLinks().length > 1) {
                more.style.display = 'inline-flex';
                const current = directVisibleLinks();
                const last = current[current.length - 1];
                if (!last) break;
                menu.prepend(last);
            }

            if (!menu.children.length) {
                more.style.display = 'none';
                closeMenu();
            }
        }

        function queueRecalc() {
            if (rafId) cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => {
                recalcOverflow();
            });
        }

        toggle.addEventListener('click', () => {
            if (!menu.children.length) return;
            if (more.classList.contains('open')) {
                closeMenu();
            } else {
                openMenu();
            }
        });

        more.addEventListener('mouseenter', openMenu);
        more.addEventListener('mouseleave', closeMenuSoon);
        menu.addEventListener('mouseenter', openMenu);
        menu.addEventListener('mouseleave', closeMenuSoon);
        toggle.addEventListener('focus', openMenu);
        menu.addEventListener('focusin', openMenu);
        menu.addEventListener('focusout', (event) => {
            if (!more.contains(event.relatedTarget)) {
                closeMenuSoon();
            }
        });

        document.addEventListener('click', (event) => {
            if (!more.contains(event.target)) {
                closeMenu();
            }
        });

        window.addEventListener('resize', queueRecalc);

        if (window.ResizeObserver) {
            const ro = new ResizeObserver(queueRecalc);
            ro.observe(nav);
            if (account) ro.observe(account);
        }

        queueRecalc();
    }

    function init() {
        document.querySelectorAll('.quick-nav').forEach(setupQuickNav);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
