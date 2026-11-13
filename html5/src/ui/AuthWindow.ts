/**
 * Окно авторизации (EntranceModel оригинала): до входа на фоне лобби видно только оно — без верхней панели и меню.
 * Вход и регистрация через сервер (LoginModel / RegistrationModel). На странице с удалённого хостинга — ещё и
 * адрес сервера (туннель моста); он запоминается в браузере (transport-ws.ts).
 */

import './auth.css';
import type { AuthMode } from './net-panel.ts';
import { getSavedBridge, isLocalPage, saveBridge } from '../net/transport-ws.ts';

/** как registration_model_command_handler сервера; пароль — до 50 символов */
const LOGIN_PATTERN = /^[A-Za-z0-9_]{1,20}$/;
const PASSWORD_MAX = 50;
const USER_KEY = 'tanki.authUser';

export class AuthWindow {
  private readonly root = document.createElement('form');
  private readonly title = document.createElement('div');
  private readonly bridgeInput = document.createElement('input');
  private readonly loginInput = document.createElement('input');
  private readonly passwordInput = document.createElement('input');
  private readonly repeatInput = document.createElement('input');
  private readonly repeatRow: HTMLLabelElement;
  private readonly rememberInput = document.createElement('input');
  private readonly status = document.createElement('div');
  private readonly submitButton = document.createElement('button');
  private readonly switchButton = document.createElement('button');
  private mode: AuthMode = 'login';
  private busy = false;

  constructor(
    parent: HTMLElement,
    private readonly authenticate: (mode: AuthMode, username: string, password: string, remember: boolean) => Promise<void>,
  ) {
    this.root.className = 'auth-window';
    this.root.hidden = true;
    this.root.autocomplete = 'on';
    this.title.className = 'auth-title';

    // адрес сервера — только на чужом хостинге без ?bridge (локально мост всегда на :5181)
    const withBridge = !isLocalPage() && !new URLSearchParams(window.location.search).has('bridge');
    const bridgeRow = this.row('Адрес сервера', this.bridgeInput, 'text');
    this.bridgeInput.placeholder = 'по умолчанию — этот сайт';
    this.bridgeInput.value = getSavedBridge();
    bridgeRow.hidden = !withBridge;

    const loginRow = this.row('Логин', this.loginInput, 'text');
    this.loginInput.autocomplete = 'username';
    try {
      this.loginInput.value = localStorage.getItem(USER_KEY) ?? '';
    } catch {
      // без хранилища логин не подставляется
    }
    const passwordRow = this.row('Пароль', this.passwordInput, 'password');
    this.passwordInput.autocomplete = 'current-password';
    this.repeatRow = this.row('Повторите пароль', this.repeatInput, 'password');
    this.repeatInput.autocomplete = 'new-password';

    const rememberRow = document.createElement('label');
    rememberRow.className = 'auth-check';
    this.rememberInput.type = 'checkbox';
    rememberRow.append(this.rememberInput, 'Запомнить меня');

    this.status.className = 'auth-status';
    this.status.setAttribute('role', 'status');

    const buttons = document.createElement('div');
    buttons.className = 'auth-buttons';
    this.submitButton.type = 'submit';
    this.submitButton.className = 'auth-submit';
    this.switchButton.type = 'button';
    this.switchButton.className = 'auth-switch';
    this.switchButton.addEventListener('click', () => this.setMode(this.mode == 'login' ? 'register' : 'login'));
    buttons.append(this.switchButton, this.submitButton);

    this.root.append(this.title, bridgeRow, loginRow, passwordRow, this.repeatRow, rememberRow, this.status, buttons);
    this.root.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submit();
    });
    parent.appendChild(this.root);
    this.setMode('login');
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  show(): void {
    this.root.hidden = false;
    (this.loginInput.value ? this.passwordInput : this.loginInput).focus();
  }

  hide(): void {
    this.root.hidden = true;
  }

  /** сообщение под полями (например, почему соединение закрыто) */
  showMessage(text: string, error = true): void {
    this.setStatus(text, error);
  }

  private row(caption: string, input: HTMLInputElement, type: string): HTMLLabelElement {
    const label = document.createElement('label');
    label.className = 'auth-row';
    const text = document.createElement('span');
    text.textContent = caption;
    input.type = type;
    input.spellcheck = false;
    label.append(text, input);
    return label;
  }

  private setMode(mode: AuthMode): void {
    this.mode = mode;
    this.title.textContent = mode == 'login' ? 'Вход в игру' : 'Регистрация';
    this.submitButton.textContent = mode == 'login' ? 'Войти' : 'Зарегистрироваться';
    this.switchButton.textContent = mode == 'login' ? 'Регистрация' : 'У меня есть аккаунт';
    this.repeatRow.hidden = mode == 'login';
    this.passwordInput.autocomplete = mode == 'login' ? 'current-password' : 'new-password';
    this.setStatus('');
  }

  private setStatus(text: string, error = false): void {
    this.status.textContent = text;
    this.status.classList.toggle('auth-error', error);
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    const username = this.loginInput.value.trim();
    const password = this.passwordInput.value;
    if (!username || !password) {
      this.setStatus('Введите логин и пароль', true);
      return;
    }
    if (this.mode == 'register') {
      if (!LOGIN_PATTERN.test(username)) {
        this.setStatus('Логин: до 20 латинских букв, цифр или «_»', true);
        return;
      }
      if (password.length > PASSWORD_MAX) {
        this.setStatus(`Пароль: не длиннее ${PASSWORD_MAX} символов`, true);
        return;
      }
      if (password != this.repeatInput.value) {
        this.setStatus('Пароли не совпадают', true);
        return;
      }
    }
    if (!this.bridgeInput.closest('label')?.hidden) saveBridge(this.bridgeInput.value);

    this.busy = true;
    this.submitButton.disabled = this.switchButton.disabled = true;
    this.setStatus(this.mode == 'login' ? 'Вход…' : 'Регистрация…');
    try {
      await this.authenticate(this.mode, username, password, this.rememberInput.checked);
      try {
        localStorage.setItem(USER_KEY, username);
      } catch {
        // не запоминаем
      }
      this.passwordInput.value = this.repeatInput.value = '';
      this.setStatus('');
      this.hide();
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      this.busy = false;
      this.submitButton.disabled = this.switchButton.disabled = false;
    }
  }
}
