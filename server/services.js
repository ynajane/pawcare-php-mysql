import nodemailer from 'nodemailer';

const E = process.env;

// Global in-memory outbox for dev/testing when SMTP is not set
export const serverOutbox = [];

export async function sendMail(to, subject, text, html) {
  const senderEmail = E.BREVO_SENDER_EMAIL || E.SMTP_USER || 'noreply@pawcare.com';
  const senderName = E.BREVO_SENDER_NAME || 'PawCare Veterinary Clinic';
  const from = `${senderName} <${senderEmail}>`;

  const record = {
    id: Math.random().toString(36).substring(2, 9),
    to,
    from,
    subject,
    text,
    html,
    sentAt: new Date().toISOString(),
  };
  serverOutbox.unshift(record);
  if (serverOutbox.length > 50) serverOutbox.pop();

  // 1. Try Brevo REST API v3 if BREVO_API_KEY is available
  if (E.BREVO_API_KEY) {
    try {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'api-key': E.BREVO_API_KEY,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sender: { name: senderName, email: senderEmail },
          to: [{ email: to }],
          subject: subject,
          textContent: text,
          htmlContent: html || `<p>${text}</p>`,
        }),
      });

      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        console.log(`Email successfully sent via Brevo API to ${to} (MessageId: ${data.messageId || 'ok'})`);
        return { ok: true, via: 'brevo_api', messageId: data.messageId };
      } else {
        const errData = await res.json().catch(() => ({}));
        console.warn('Brevo REST API notice:', errData.message || res.statusText, '- attempting SMTP fallback...');
      }
    } catch (brevoErr) {
      console.warn('Brevo API request failed:', brevoErr.message);
    }
  }

  // 2. Try SMTP via Nodemailer (supports Gmail & custom SMTP relays)
  const smtpPass = (E.SMTP_PASS && E.SMTP_PASS !== 'your_master_smtp_password') ? E.SMTP_PASS : E.BREVO_API_KEY;
  if (E.SMTP_USER && smtpPass) {
    try {
      const isGmail = (E.SMTP_HOST || '').includes('gmail') || (E.SMTP_USER || '').endsWith('@gmail.com');
      const transportConfig = isGmail
        ? {
            service: 'gmail',
            auth: {
              user: E.SMTP_USER,
              pass: smtpPass.replace(/\s+/g, ''), // Automatically strips spaces from 16-char App Password
            },
          }
        : {
            host: E.SMTP_HOST || 'smtp-relay.brevo.com',
            port: Number(E.SMTP_PORT) || 587,
            secure: Number(E.SMTP_PORT) === 465,
            auth: {
              user: E.SMTP_USER,
              pass: smtpPass,
            },
          };

      const transport = nodemailer.createTransport(transportConfig);
      await transport.sendMail({ from, to, subject, text, html });
      console.log(`Email sent via SMTP (${isGmail ? 'Gmail' : E.SMTP_HOST}) to ${to}: "${subject}"`);
      return { ok: true, via: 'smtp' };
    } catch (err) {
      console.error('SMTP send failed:', err.message);
    }
  }

  console.log(`[Dev Mail Delivery] To: ${to} | Subject: ${subject}`);
  return { ok: true, via: 'dev_outbox' };
}

// Gateways need international format: 09171234567 / 9171234567 / 639171234567 -> +639171234567
export function toE164PH(raw) {
  const d = String(raw || '').replace(/[^\d]/g, '');
  if (/^0\d{10}$/.test(d)) return '+63' + d.slice(1);
  if (/^9\d{9}$/.test(d)) return '+63' + d;
  if (/^63\d{10}$/.test(d)) return '+' + d;
  return String(raw || '').trim();
}

export async function sendSms(rawPhone, message) {
  const phone = toE164PH(rawPhone);
  const record = {
    id: Math.random().toString(36).substring(2, 9),
    phone,
    message,
    sentAt: new Date().toISOString(),
  };
  serverOutbox.unshift(record);

  // 1. TextBee Gateway (https://textbee.dev)
  const textbeeKey = E.TEXTBEE_API_KEY || E.TEXTBEE_KEY;
  if (textbeeKey) {
    try {
      const deviceId = E.TEXTBEE_DEVICE_ID;
      const url = deviceId
        ? `https://api.textbee.dev/api/v1/gateway/devices/${deviceId}/send-sms`
        : 'https://api.textbee.dev/api/v1/gateway/send-sms';

      const payload = {
        recipients: [phone],
        message: message,
      };
      if (deviceId) payload.device_id = deviceId;

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': textbeeKey,
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        console.log(`✅ TextBee SMS dispatched to ${phone}`);
        return { ok: true, via: 'textbee', data };
      } else {
        console.warn('TextBee notice:', data.message || res.statusText);
      }
    } catch (err) {
      console.error('TextBee SMS request failed:', err.message);
    }
  }

  // 2. PhilSMS Gateway Fallback
  if (E.PHILSMS_TOKEN || E.PHILSMS_API_TOKEN) {
    const token = E.PHILSMS_TOKEN || E.PHILSMS_API_TOKEN;
    try {
      const res = await fetch('https://app.philsms.com/api/v3/sms/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          recipient: phone.replace(/^\+/, ''),
          sender_id: 'PhilSMS',
          type: 'plain',
          message: message,
        }),
      });
      const data = await res.json().catch(() => ({}));
      // PhilSMS answers 200 with status "error" for rejected messages (no credit, bad number), so check both.
      if (res.ok && data.status !== 'error') {
        console.log('PhilSMS sent:', data);
        return { ok: true, via: 'philsms' };
      }
      console.warn('PhilSMS notice:', data.message || res.statusText);
    } catch (err) {
      console.error('PhilSMS failed:', err.message);
    }
  }

  console.log(`[Dev SMS Delivery] To: ${phone} | Msg: ${message}`);
  return { ok: true, via: 'dev_outbox' };
}
