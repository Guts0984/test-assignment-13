import type { Pool } from '@auction/db';
import { formatMoney, type AppLocale } from '@auction/shared';
import nodemailer from 'nodemailer';

export type MailerConfig = { readonly host: string; readonly port: number; readonly from: string };
export type Mailer = {
  readonly send: (message: {
    to: string;
    subject: string;
    text: string;
    messageId: string;
  }) => Promise<void>;
  readonly close: () => void;
};

export const createMailer = (config: MailerConfig): Mailer => {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: false,
    ignoreTLS: true,
    pool: true,
    maxConnections: 3,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10_000,
  });
  return {
    send: async (m) => {
      await transport.sendMail({
        from: config.from,
        to: m.to,
        subject: m.subject,
        text: m.text,
        messageId: m.messageId,
      });
    },
    close: () => {
      transport.close();
    },
  };
};

type Payload = Readonly<Record<string, unknown>>;
type Rendered = { subject: string; text: string };

const str = (p: Payload, key: string): string => {
  const v = p[key];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
};
const money = (p: Payload, key: string, locale: AppLocale): string => {
  const v = p[key];
  return typeof v === 'number' ? formatMoney(v, locale) : '';
};
const pick = (locale: AppLocale, text: Record<AppLocale, string>): string => text[locale];

type Template = (p: Payload, l: AppLocale) => Rendered;

const TEMPLATES: Readonly<Record<string, Template>> = {
  outbid: (p, l) => ({
    subject: pick(l, {
      en: `You were outbid: ${str(p, 'title')}`,
      uk: `Вашу ставку перебито: ${str(p, 'title')}`,
      pl: `Ktoś Cię przebił: ${str(p, 'title')}`,
    }),
    text: pick(l, {
      en: `Someone placed a higher bid on "${str(p, 'title')}". The price is now ${money(p, 'currentPrice', l)}.`,
      uk: `Хтось поставив більше на «${str(p, 'title')}». Тепер ціна ${money(p, 'currentPrice', l)}.`,
      pl: `Ktoś zaproponował więcej za „${str(p, 'title')}”. Cena wynosi teraz ${money(p, 'currentPrice', l)}.`,
    }),
  }),
  won: (p, l) => ({
    subject: pick(l, {
      en: `You won: ${str(p, 'title')}`,
      uk: `Ви виграли: ${str(p, 'title')}`,
      pl: `Wygrałeś: ${str(p, 'title')}`,
    }),
    text: pick(l, {
      en: `You won "${str(p, 'title')}" for ${money(p, 'price', l)}. Pay within 48 hours.`,
      uk: `Ви виграли «${str(p, 'title')}» за ${money(p, 'price', l)}. Оплатіть протягом 48 годин.`,
      pl: `Wygrałeś „${str(p, 'title')}” za ${money(p, 'price', l)}. Zapłać w ciągu 48 godzin.`,
    }),
  }),
  second_chance: (p, l) => ({
    subject: pick(l, {
      en: `Second chance: ${str(p, 'title')}`,
      uk: `Другий шанс: ${str(p, 'title')}`,
      pl: `Druga szansa: ${str(p, 'title')}`,
    }),
    text: pick(l, {
      en: `The winner did not pay. "${str(p, 'title')}" is yours for ${money(p, 'price', l)} if you pay within 24 hours.`,
      uk: `Переможець не оплатив. «${str(p, 'title')}» ваш за ${money(p, 'price', l)}, якщо оплатите протягом 24 годин.`,
      pl: `Zwycięzca nie zapłacił. „${str(p, 'title')}” jest Twój za ${money(p, 'price', l)}, jeśli zapłacisz w ciągu 24 godzin.`,
    }),
  }),
  lot_removed: (p, l) => ({
    subject: pick(l, {
      en: `Lot removed: ${str(p, 'title')}`,
      uk: `Лот знято: ${str(p, 'title')}`,
      pl: `Aukcja usunięta: ${str(p, 'title')}`,
    }),
    text: pick(l, {
      en: `A moderator removed "${str(p, 'title')}". Bids were cancelled and deposits released.`,
      uk: `Модератор зняв «${str(p, 'title')}». Ставки анульовано, застави звільнено.`,
      pl: `Moderator usunął „${str(p, 'title')}”. Oferty anulowano, kaucje zwolniono.`,
    }),
  }),
  favorite_reminder: (p, l) => ({
    subject: pick(l, {
      en: `Ending soon: ${str(p, 'title')}`,
      uk: `Скоро завершиться: ${str(p, 'title')}`,
      pl: `Wkrótce koniec: ${str(p, 'title')}`,
    }),
    text: pick(l, {
      en: `"${str(p, 'title')}" from your favourites ends in about an hour.`,
      uk: `«${str(p, 'title')}» з обраного завершується приблизно за годину.`,
      pl: `„${str(p, 'title')}” z ulubionych kończy się za około godzinę.`,
    }),
  }),
  lot_sold: (p, l) => ({
    subject: pick(l, {
      en: `Sold: ${str(p, 'title')}`,
      uk: `Продано: ${str(p, 'title')}`,
      pl: `Sprzedane: ${str(p, 'title')}`,
    }),
    text: pick(l, {
      en: `Your lot sold for ${money(p, 'price', l)}.`,
      uk: `Ваш лот продано за ${money(p, 'price', l)}.`,
      pl: `Twoja aukcja sprzedana za ${money(p, 'price', l)}.`,
    }),
  }),
  lot_unsold: (p, l) => ({
    subject: pick(l, {
      en: `Ended without a sale: ${str(p, 'title')}`,
      uk: `Завершено без продажу: ${str(p, 'title')}`,
      pl: `Zakończono bez sprzedaży: ${str(p, 'title')}`,
    }),
    text: pick(l, {
      en: 'Your lot ended without a sale.',
      uk: 'Ваш лот завершено без продажу.',
      pl: 'Twoja aukcja zakończyła się bez sprzedaży.',
    }),
  }),
  lot_paid: (p, l) => ({
    subject: pick(l, {
      en: `Paid: ${str(p, 'title')}`,
      uk: `Оплачено: ${str(p, 'title')}`,
      pl: `Opłacone: ${str(p, 'title')}`,
    }),
    text: pick(l, {
      en: `The buyer paid ${money(p, 'price', l)}. Please ship the item.`,
      uk: `Покупець оплатив ${money(p, 'price', l)}. Відправте товар.`,
      pl: `Kupujący zapłacił ${money(p, 'price', l)}. Wyślij przedmiot.`,
    }),
  }),
  lot_shipped: (p, l) => ({
    subject: pick(l, {
      en: `Shipped: ${str(p, 'title')}`,
      uk: `Відправлено: ${str(p, 'title')}`,
      pl: `Wysłane: ${str(p, 'title')}`,
    }),
    text: pick(l, {
      en: `Tracking number: ${str(p, 'trackingNumber')}.`,
      uk: `Номер відстеження: ${str(p, 'trackingNumber')}.`,
      pl: `Numer przesyłki: ${str(p, 'trackingNumber')}.`,
    }),
  }),
  payout: (p, l) => ({
    subject: pick(l, {
      en: `Payout: ${str(p, 'title')}`,
      uk: `Виплата: ${str(p, 'title')}`,
      pl: `Wypłata: ${str(p, 'title')}`,
    }),
    text: pick(l, {
      en: `${money(p, 'amount', l)} was added to your wallet.`,
      uk: `${money(p, 'amount', l)} зараховано на ваш гаманець.`,
      pl: `${money(p, 'amount', l)} dodano do Twojego portfela.`,
    }),
  }),
  lot_approved: (p, l) => ({
    subject: pick(l, {
      en: `Approved: ${str(p, 'title')}`,
      uk: `Схвалено: ${str(p, 'title')}`,
      pl: `Zatwierdzone: ${str(p, 'title')}`,
    }),
    text: pick(l, {
      en: 'Your lot is live.',
      uk: 'Ваш лот опубліковано.',
      pl: 'Twoja aukcja jest aktywna.',
    }),
  }),
  lot_rejected: (p, l) => ({
    subject: pick(l, {
      en: `Rejected: ${str(p, 'title')}`,
      uk: `Відхилено: ${str(p, 'title')}`,
      pl: `Odrzucone: ${str(p, 'title')}`,
    }),
    text: pick(l, {
      en: `Reason: ${str(p, 'reason')}`,
      uk: `Причина: ${str(p, 'reason')}`,
      pl: `Powód: ${str(p, 'reason')}`,
    }),
  }),
};

export const renderEmail = (kind: string, payload: Payload, locale: AppLocale): Rendered =>
  (TEMPLATES[kind] ?? ((): Rendered => ({ subject: kind, text: JSON.stringify(payload) })))(
    payload,
    locale,
  );

export type EmailResult = 'sent' | 'skipped' | 'failed';

const MAX_ATTEMPTS = 5;

/**
 * Sends one queued email. The row is locked (FOR UPDATE SKIP LOCKED) while it is being sent, so
 * several workers, or a duplicate job, can never send it twice; a row that is already sent or
 * failed is skipped. The window for a duplicate is a crash between the SMTP "250 OK" and the
 * UPDATE; the message-id is the row id, so a duplicate would at least be recognisable.
 */
export const sendEmailById = async (
  pool: Pool,
  mailer: Mailer,
  emailId: string,
  now: () => Date = () => new Date(),
): Promise<EmailResult> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{
      id: string;
      kind: string;
      payload: Payload;
      attempts: number;
      email: string;
      locale: AppLocale;
    }>(
      `SELECT e.id, e.kind, e.payload, e.attempts, u.email, u.locale
         FROM email_log e JOIN users u ON u.id = e.user_id
        WHERE e.id = $1 AND e.status = 'pending'
          FOR UPDATE OF e SKIP LOCKED`,
      [emailId],
    );
    const row = rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return 'skipped';
    }
    const { subject, text } = renderEmail(row.kind, row.payload, row.locale);
    try {
      await mailer.send({ to: row.email, subject, text, messageId: `<${row.id}@auction.local>` });
    } catch {
      const failed = row.attempts + 1 >= MAX_ATTEMPTS;
      await client.query(
        `UPDATE email_log SET attempts = attempts + 1, status = $2 WHERE id = $1`,
        [row.id, failed ? 'failed' : 'pending'],
      );
      await client.query('COMMIT');
      return 'failed';
    }
    await client.query(
      `UPDATE email_log SET status = 'sent', sent_at = $2, attempts = attempts + 1 WHERE id = $1`,
      [row.id, now()],
    );
    await client.query('COMMIT');
    return 'sent';
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
};
