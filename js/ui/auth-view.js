// Email OTP login: step 1 email, step 2 six-digit code. Errors are one calm line.
import { h } from './dom.js';
import { authMessage } from '../lib/auth-gate.js';

export function renderAuth(root, { client, onSignedIn }) {
  let email = '';
  let busy = false;

  function field({ id, label, props }) {
    const input = h('input', { id, class: 'field', required: true, ...props });
    const err = h('p', { class: 'auth-error danger', role: 'alert', hidden: true });
    const wrap = h('div', { class: 'auth-field' }, h('label', { for: id }, label), input, err);
    const setError = (text) => { err.textContent = text ?? ''; err.hidden = !text; input.setAttribute('aria-invalid', text ? 'true' : 'false'); };
    return { wrap, input, setError };
  }

  function screen(...kids) {
    root.replaceChildren(h('section', { class: 'auth' }, ...kids));
  }

  function stepEmail() {
    const f = field({
      id: 'auth-email', label: 'Email',
      props: { type: 'email', autocomplete: 'email', inputmode: 'email', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'send' },
    });
    f.input.value = email; // only what was typed in this session, never from the repo
    const btn = h('button', { type: 'submit', class: 'tap primary' }, 'Send code');
    const form = h('form', { class: 'auth-form', novalidate: true },
      h('div', { class: 'auth-body' },
        h('h1', {}, 'Sign in'),
        h('p', { class: 'muted' }, 'Enter your email. We send a 6-digit code.'),
        f.wrap),
      btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      const value = f.input.value.trim();
      if (!value || !f.input.validity.valid) { f.setError('Enter a valid email address.'); return; }
      busy = true; btn.disabled = true; btn.textContent = 'Sending'; f.setError(null);
      try {
        const { error } = await client.auth.signInWithOtp({ email: value, options: { shouldCreateUser: false } });
        if (error) throw error;
        email = value;
        busy = false;
        stepCode();
      } catch (err) {
        busy = false; btn.disabled = false; btn.textContent = 'Send code';
        f.setError(authMessage(err, 'send'));
      }
    });
    screen(form);
    f.input.focus();
  }

  function stepCode() {
    const f = field({
      id: 'auth-code', label: 'Code',
      props: { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, pattern: '[0-9]*', enterkeyhint: 'go', autocapitalize: 'off' },
    });
    const btn = h('button', { type: 'submit', class: 'tap primary' }, 'Sign in');
    const again = h('button', { type: 'button', class: 'tap link' }, 'Use another email');
    const form = h('form', { class: 'auth-form', novalidate: true },
      h('div', { class: 'auth-body' },
        h('h1', {}, 'Enter code'),
        h('p', { class: 'muted' }, `Sent to ${email}.`),
        f.wrap,
        again),
      btn);

    const verify = async () => {
      if (busy) return;
      const token = f.input.value.replace(/\D/g, '');
      if (token.length !== 6) { f.setError('Enter the 6-digit code.'); return; }
      busy = true; btn.disabled = true; btn.textContent = 'Checking'; f.setError(null);
      try {
        const { data, error } = await client.auth.verifyOtp({ email, token, type: 'email' });
        if (error) throw error;
        busy = false;
        onSignedIn?.(data?.session ?? null);
      } catch (err) {
        busy = false; btn.disabled = false; btn.textContent = 'Sign in';
        f.setError(authMessage(err, 'verify'));
        f.input.select();
      }
    };
    f.input.addEventListener('input', () => {
      const digits = f.input.value.replace(/\D/g, '').slice(0, 6);
      if (digits !== f.input.value) f.input.value = digits;
      if (digits.length === 6) verify();
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); verify(); });
    again.addEventListener('click', () => { if (!busy) stepEmail(); });
    screen(form);
    f.input.focus();
  }

  stepEmail();
}
