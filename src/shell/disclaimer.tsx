import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { isBoolean } from '../core/storage/ui-state';
import { usePersistentState } from '../core/ui/use-persistent-state';

export function FirstVisit({ children }: { children: ReactNode }) {
  const [acknowledged, setAcknowledged] = usePersistentState('welcome-acknowledged', false, isBoolean);

  // Mount the workspace after acknowledgment so restored dialogs cannot cover the notice.
  return acknowledged ? children : <WelcomeDisclaimer onAcknowledge={() => setAcknowledged(true)} />;
}

function WelcomeDisclaimer({ onAcknowledge }: { onAcknowledge: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const [atBottom, setAtBottom] = useState(false);

  useEffect(() => {
    const popup = dialog.current;
    const content = body.current;
    if (!popup || !content) return;
    popup.showModal();
    content.scrollTo(0, 0);
    title.current?.focus({ preventScroll: true });
    const updateScrollPosition = () => {
      // scrollTop can be fractional even though the element heights are rounded.
      setAtBottom(content.scrollHeight - content.clientHeight - content.scrollTop <= 1);
    };
    updateScrollPosition();
    content.addEventListener('scroll', updateScrollPosition);
    const resize = new ResizeObserver(updateScrollPosition);
    resize.observe(content);
    for (const child of content.children) resize.observe(child);
    return () => {
      content.removeEventListener('scroll', updateScrollPosition);
      resize.disconnect();
      popup.close();
    };
  }, []);

  return createPortal(<dialog ref={dialog} className="about-dialog disclaimer-dialog"
      aria-labelledby="welcome-title"
      onCancel={event => event.preventDefault()}>
      <header className="about-heading">
        <div>
          <img src="/icon.svg" alt="" width="44" height="44" />
          <h2 id="welcome-title" ref={title} tabIndex={-1}>Welcome to ZLayer</h2>
        </div>
      </header>

      <div ref={body} className="about-body disclaimer-body panel-scroll" tabIndex={0}
        role="region" aria-label="Installation and safety notice">
        <section className="welcome-install" aria-labelledby="install-title">
          <h3 id="install-title">Take ZLayer with you</h3>
          <p>ZLayer is a progressive web app (PWA). Add it to your home screen
            and use downloaded charts and data offline. No app store needed.</p>
          <dl className="welcome-install-steps">
            <div>
              <dt>iPhone and iPad</dt>
              <dd>In Safari, choose “Add to home screen” from the share menu.
                Enable “Open as web app” if shown, then tap “Add”.</dd>
            </div>
            <div>
              <dt>Android</dt>
              <dd>In Chrome, open the ⋮ menu, choose “Install and create shortcut”
                (or “Add to home screen”), then tap “Install”.</dd>
            </div>
          </dl>
          <p>Open the installed app online, download regions in settings, and
            check them in airplane mode before you go. Fresh weather and updates
            need internet.</p>
        </section>

        <section className="disclaimer-summary" aria-labelledby="disclaimer-development">
          <span className="disclaimer-status">In active development</span>
          <h3 id="disclaimer-development">Safety disclaimer</h3>
          <p>ZLayer is an experimental, personal hobby project for supplemental
            reference. It is not certified for navigation or flight-critical use.
            Features and data may be incomplete, inaccurate, outdated, or unavailable.</p>
        </section>

        <section aria-labelledby="disclaimer-responsibility">
          <h3 id="disclaimer-responsibility">Your responsibility</h3>
          <p>Do not rely on ZLayer for navigation, aircraft control, or safety-critical
            decisions, even as a backup. Reliance during flight could result in
            serious injury, death, or property damage. Independently verify all
            information against current official sources, approved aircraft instruments,
            and applicable requirements. Check data currency, downloads, and device
            operation before each flight; maintain appropriate independent backups.
            The pilot in command remains responsible for safe operation.</p>
        </section>

        <section aria-labelledby="disclaimer-warranty">
          <h3 id="disclaimer-warranty">No warranty</h3>
          <p>To the fullest extent permitted by applicable law, ZLayer and its data
            are provided <strong>“as is” and “as available,” with all faults and
            without warranties of any kind</strong>, express or implied, including
            merchantability, fitness for a particular purpose, non-infringement,
            accuracy, reliability, or availability. No advice or information from
            the author or contributors creates a warranty.</p>
        </section>

        <section aria-labelledby="disclaimer-liability">
          <h3 id="disclaimer-liability">Assumption of risk and limitation of liability</h3>
          <p>You use ZLayer at your own risk. To the fullest extent permitted by
            applicable law, the author, contributors, and distributors disclaim
            liability for any loss, injury, or damage arising from use of, reliance
            on, or inability to use the app or its data, under any legal theory,
            including negligence, even if advised of the possibility. This includes
            direct, indirect, incidental, special, and consequential damages.
            Nothing in this notice excludes liability or rights that cannot
            lawfully be excluded or limited.</p>
        </section>

        <p className="disclaimer-acknowledgment">By selecting “I understand,” you
          acknowledge the app’s development status, these risks and limitations,
          and your responsibility to verify information independently.</p>
      </div>

      <footer className="disclaimer-footer">
        <button className="ui-button ui-button--primary" type="button" disabled={!atBottom} onClick={onAcknowledge}>I understand</button>
      </footer>
    </dialog>, document.body);
}
