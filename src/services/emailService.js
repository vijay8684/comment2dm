/**
 * Comment2DM — Email Delivery Service
 * Backed by Resend API (https://resend.com)
 * Handles: Signup verification OTPs, Password reset OTPs, and Security alerts.
 */

'use strict';

const RESEND_API_URL = 'https://api.resend.com/emails';

/**
 * Sends a transactional email using Resend API.
 * Never logs API keys or sensitive contents.
 *
 * @param {Object} options
 * @param {string} options.to - Recipient email address
 * @param {string} options.subject - Email subject line
 * @param {string} options.html - HTML body
 * @param {string} [options.text] - Plaintext alternative
 * @returns {Promise<{ success: boolean, id?: string, error?: string, devMode?: boolean }>}
 */
async function sendEmail({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL || process.env.EMAIL_FROM || 'Comment2DM <onboarding@resend.dev>';

  if (!apiKey) {
    if (process.env.NODE_ENV !== 'production' || process.env.ALLOW_DEV_OTP === 'true') {
      console.log(`[EmailService:Dev] No RESEND_API_KEY set. Simulated delivery to: ${to}`);
      return { success: true, devMode: true };
    }
    return { success: false, error: 'Email service credentials are not configured.' };
  }

  try {
    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [to],
        subject,
        html,
        text: text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const errMsg = data?.message || data?.error || `Resend HTTP error ${response.status}`;
      console.warn(`[EmailService] Resend delivery notice for ${to}: ${errMsg}`);
      const isDomainRestriction = response.status === 403 && String(errMsg).includes('testing emails to your own email address');
      return {
        success: false,
        error: errMsg,
        statusCode: response.status,
        isDomainRestriction
      };
    }

    return { success: true, id: data?.id };
  } catch (err) {
    console.error(`[EmailService] Network error dispatching email to ${to}:`, err.message);
    return { success: false, error: 'Unable to deliver verification email at this time.' };
  }
}

/**
 * Builds an authentic, responsive Comment2DM branded email template.
 */
function buildBrandedTemplate({ title, subtitle, otp, extraMessage, actionNote }) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0D0B12; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; color: #F8F7FA;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #0D0B12; padding: 40px 16px;">
    <tr>
      <td align="center">
        <!-- Main Card Container -->
        <table role="presentation" width="100%" style="max-width: 520px; background-color: #15121D; border-radius: 18px; border: 1px solid rgba(255, 255, 255, 0.1); overflow: hidden; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);">
          
          <!-- Header Bar with Logo -->
          <tr>
            <td style="padding: 32px 36px 20px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); text-align: left;">
              <table role="presentation" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="background: #191621; border-radius: 10px; width: 34px; height: 34px; text-align: center; border: 1px solid rgba(255, 255, 255, 0.15);">
                    <span style="font-size: 18px; color: #FF9B45;">⚡</span>
                  </td>
                  <td style="padding-left: 12px;">
                    <span style="font-size: 19px; font-weight: 800; letter-spacing: -0.02em; color: #F8F7FA;">
                      Comment<span style="color: #936BFF;">2</span>DM
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Content Body -->
          <tr>
            <td style="padding: 32px 36px;">
              <h1 style="font-size: 22px; font-weight: 700; margin: 0 0 8px; color: #FFFFFF; letter-spacing: -0.01em;">
                ${title}
              </h1>
              <p style="font-size: 14px; line-height: 1.6; color: #AAA4B5; margin: 0 0 28px;">
                ${subtitle}
              </p>

              <!-- OTP Code Display Card -->
              <div style="background-color: #191621; border: 1px solid rgba(147, 107, 255, 0.35); border-radius: 14px; padding: 24px 20px; text-align: center; margin-bottom: 28px;">
                <span style="display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.15em; color: #936BFF; font-weight: 700; margin-bottom: 10px;">
                  Your 6-Digit Verification Code
                </span>
                <span style="display: inline-block; font-family: 'SF Mono', Monaco, Consolas, monospace; font-size: 36px; font-weight: 800; letter-spacing: 0.28em; color: #FFFFFF; background: linear-gradient(135deg, #FFFFFF 0%, #936BFF 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">
                  ${otp}
                </span>
                <span style="display: block; font-size: 12px; color: #AAA4B5; margin-top: 10px;">
                  ⏱️ Expires in <strong>5 minutes</strong>
                </span>
              </div>

              ${extraMessage ? `
              <p style="font-size: 13px; line-height: 1.5; color: #AAA4B5; margin: 0 0 20px;">
                ${extraMessage}
              </p>` : ''}

              <p style="font-size: 12px; line-height: 1.5; color: #767082; margin: 0; padding-top: 16px; border-top: 1px solid rgba(255, 255, 255, 0.08);">
                ${actionNote || 'If you did not request this verification code, please ignore this email or secure your account.'}
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #0E0C13; padding: 20px 36px; border-top: 1px solid rgba(255, 255, 255, 0.06); text-align: center;">
              <p style="font-size: 11px; color: #5E5873; margin: 0 0 4px;">
                © ${new Date().getFullYear()} Comment2DM by VI TECH Limited. All rights reserved.
              </p>
              <p style="font-size: 11px; color: #5E5873; margin: 0;">
                Official Meta Graph API Automated Messaging Platform
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
}

/**
 * Sends a 6-digit signup email verification OTP.
 */
async function sendSignupOtpEmail(target, otpArg, nameArg) {
  let to, name, otp;
  if (typeof target === 'object' && target !== null) {
    ({ to, name, otp } = target);
  } else {
    to = target;
    otp = otpArg;
    name = nameArg;
  }
  const safeName = String(name || '').trim().split(' ')[0] || 'there';
  const html = buildBrandedTemplate({
    title: `Verify your email address`,
    subtitle: `Hi ${safeName}, thanks for creating an account on Comment2DM! Please enter the 6-digit verification code below to activate your account.`,
    otp,
    extraMessage: `Once verified, you'll be able to connect your Instagram accounts, configure intelligent keyword triggers, and start automating comment-to-DM conversations.`,
    actionNote: `If you didn't create a Comment2DM account, you can safely disregard this email.`
  });

  return sendEmail({
    to,
    subject: `${otp} is your Comment2DM verification code`,
    html
  });
}

/**
 * Sends a 6-digit password reset verification OTP.
 */
async function sendPasswordResetOtpEmail(target, otpArg, nameArg) {
  let to, name, otp;
  if (typeof target === 'object' && target !== null) {
    ({ to, name, otp } = target);
  } else {
    to = target;
    otp = otpArg;
    name = nameArg;
  }
  const safeName = String(name || '').trim().split(' ')[0] || 'there';
  const html = buildBrandedTemplate({
    title: `Reset your password`,
    subtitle: `Hi ${safeName}, we received a request to reset the password for your Comment2DM account. Use the code below to proceed.`,
    otp,
    extraMessage: `For your security, never share this code with anyone. Comment2DM staff will never ask for your verification code.`,
    actionNote: `If you didn't request a password reset, someone may have entered your email by mistake. Your account remains secure.`
  });

  return sendEmail({
    to,
    subject: `${otp} is your Comment2DM password reset code`,
    html
  });
}

/**
 * Sends a security notification when password has been successfully changed.
 */
async function sendPasswordChangedAlert(target, nameArg) {
  let to, name;
  if (typeof target === 'object' && target !== null) {
    ({ to, name } = target);
  } else {
    to = target;
    name = nameArg;
  }
  const safeName = String(name || '').trim().split(' ')[0] || 'there';
  const html = `
<!DOCTYPE html>
<html>
<body style="margin: 0; padding: 24px; background: #0D0B12; font-family: sans-serif; color: #F8F7FA;">
  <div style="max-width: 500px; margin: auto; background: #15121D; border-radius: 14px; padding: 28px; border: 1px solid rgba(255,255,255,0.1);">
    <h2 style="color: #10B981; margin-top: 0;">Password Successfully Reset</h2>
    <p style="color: #AAA4B5; font-size: 14px; line-height: 1.6;">
      Hi ${safeName}, the password for your Comment2DM account (<strong>${to}</strong>) was just changed.
    </p>
    <p style="color: #AAA4B5; font-size: 13px; line-height: 1.6;">
      If you made this change, no further action is required. If you did not make this change, please contact support immediately at <a href="mailto:support@comment2dm.com" style="color: #936BFF;">support@comment2dm.com</a>.
    </p>
  </div>
</body>
</html>
`;

  return sendEmail({
    to,
    subject: `Your Comment2DM password was updated`,
    html
  });
}

module.exports = {
  sendEmail,
  sendSignupOtpEmail,
  sendSignupOtp: sendSignupOtpEmail,
  sendPasswordResetOtpEmail,
  sendPasswordResetOtp: sendPasswordResetOtpEmail,
  sendPasswordChangedAlert,
  sendPasswordChangeAlert: sendPasswordChangedAlert
};
