/**
 * Comment2DM — Email Delivery Service
 * Backed by Resend API (https://resend.com)
 * Handles: Signup verification OTPs, Password reset OTPs, and Security alerts.
 * Design: Premium lavender/violet/magenta brand identity with high-contrast, responsive layouts.
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
 * Builds an authentic, responsive, premium Comment2DM branded email template.
 * Matches Comment2DM's violet, lavender, and magenta brand identity.
 * Renders cleanly across Gmail, Apple Mail, Outlook, and mobile email apps.
 */
function buildBrandedTemplate({ categoryPill, title, subtitle, otp, extraCallout, actionNote }) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #F5F3F9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; color: #1A1528; -webkit-font-smoothing: antialiased;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #F5F3F9; padding: 40px 16px;">
    <tr>
      <td align="center">
        <!-- Main Card Container -->
        <table role="presentation" width="100%" style="max-width: 520px; background-color: #FFFFFF; border-radius: 20px; border: 1px solid #E5E0F0; overflow: hidden; box-shadow: 0 12px 36px rgba(118, 85, 217, 0.08);">
          
          <!-- Gradient Highlight Strip (Violet to Magenta) -->
          <tr>
            <td style="height: 4px; background: linear-gradient(90deg, #7655D9 0%, #936BFF 50%, #D946A8 100%);"></td>
          </tr>

          <!-- Header Bar with Logo and Security Badge -->
          <tr>
            <td style="padding: 28px 36px 20px; border-bottom: 1px solid #F1EDF8;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <!-- Brand Logo -->
                  <td align="left" style="vertical-align: middle;">
                    <table role="presentation" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="background-color: #7655D9; border-radius: 9px; width: 34px; height: 34px; text-align: center; vertical-align: middle;">
                          <span style="font-size: 18px; line-height: 1;">⚡</span>
                        </td>
                        <td style="padding-left: 10px; vertical-align: middle;">
                          <span style="font-size: 18px; font-weight: 800; letter-spacing: -0.02em; color: #1A1528;">
                            Comment<span style="color: #936BFF;">2</span>DM
                          </span>
                        </td>
                      </tr>
                    </table>
                  </td>
                  <!-- Category Pill -->
                  <td align="right" style="vertical-align: middle;">
                    <span style="display: inline-block; background-color: #EDE9FE; color: #6D28D9; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; padding: 5px 10px; border-radius: 100px;">
                      ${categoryPill || 'Verification'}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Content Body -->
          <tr>
            <td style="padding: 32px 36px 28px;">
              <h1 style="font-size: 22px; font-weight: 800; line-height: 1.3; margin: 0 0 10px; color: #1A1528; letter-spacing: -0.02em;">
                ${title}
              </h1>
              <p style="font-size: 14px; line-height: 1.6; color: #524C61; margin: 0 0 24px;">
                ${subtitle}
              </p>

              <!-- OTP Code Display Card -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #FAF8FF; border: 1.5px solid #DDD6FE; border-radius: 14px; margin-bottom: 24px;">
                <tr>
                  <td style="padding: 22px 20px; text-align: center;">
                    <span style="display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; color: #7655D9; font-weight: 700; margin-bottom: 8px;">
                      Your 6-Digit Verification Code
                    </span>
                    <span style="display: block; font-family: 'SF Mono', Consolas, Monaco, monospace; font-size: 34px; font-weight: 800; letter-spacing: 7px; color: #5B21B6; line-height: 1.2;">
                      ${otp}
                    </span>
                    <span style="display: inline-block; font-size: 12px; font-weight: 600; color: #6B7280; margin-top: 8px;">
                      ⏱️ Valid for <strong>5 minutes</strong> • Single-use only
                    </span>
                  </td>
                </tr>
              </table>

              ${extraCallout ? `
              <!-- Feature Context Callout -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #F8F6FD; border: 1px solid #EBE5FA; border-radius: 12px; margin-bottom: 22px;">
                <tr>
                  <td style="padding: 14px 18px; font-size: 13px; line-height: 1.55; color: #524C61;">
                    ${extraCallout}
                  </td>
                </tr>
              </table>` : ''}

              <!-- Security Warning -->
              <p style="font-size: 12px; line-height: 1.55; color: #767082; margin: 0; padding-top: 18px; border-top: 1px solid #F1EDF8;">
                ${actionNote || 'Never share your verification code. Comment2DM staff will never ask for your code.'}
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #FBF9FE; padding: 22px 36px; border-top: 1px solid #F1EDF8; text-align: center;">
              <p style="font-size: 11px; color: #7A748A; margin: 0 0 4px; font-weight: 500;">
                © ${new Date().getFullYear()} Comment2DM by VI TECH Limited. All rights reserved.
              </p>
              <p style="font-size: 11px; color: #9A94AA; margin: 0;">
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
    categoryPill: 'Account Setup',
    title: `Verify your email address`,
    subtitle: `Hi ${safeName}, thanks for creating an account on Comment2DM! Please enter the 6-digit verification code below to verify your email and activate your account.`,
    otp,
    extraCallout: `
      <strong style="color: #1A1528; display: block; margin-bottom: 4px;">What happens next?</strong>
      Once verified, you'll be able to connect your Instagram accounts, configure intelligent keyword triggers, and start turning Reel comments into direct sales.
    `,
    actionNote: `If you didn't create a Comment2DM account, you can safely disregard this email. Your email address has not been added to any marketing lists.`
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
    categoryPill: 'Password Reset',
    title: `Reset your password`,
    subtitle: `Hi ${safeName}, we received a request to reset the password for your Comment2DM account (${to}). Use the 6-digit code below to set your new password.`,
    otp,
    extraCallout: `
      <strong style="color: #1A1528; display: block; margin-bottom: 4px;">Security Reminder:</strong>
      For your security, never share this code with anyone. If you did not make this request, someone may have entered your email by mistake. Your account password remains unchanged.
    `,
    actionNote: `If you didn't request a password reset, you can safely ignore this email. Your account remains secure.`
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
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Security Alert: Password Updated</title>
</head>
<body style="margin: 0; padding: 0; background-color: #F5F3F9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; color: #1A1528;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #F5F3F9; padding: 40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 520px; background-color: #FFFFFF; border-radius: 20px; border: 1px solid #E5E0F0; overflow: hidden; box-shadow: 0 12px 36px rgba(118, 85, 217, 0.08);">
          
          <!-- Gradient Top Highlight -->
          <tr>
            <td style="height: 4px; background: linear-gradient(90deg, #10B981 0%, #7655D9 100%);"></td>
          </tr>

          <!-- Header -->
          <tr>
            <td style="padding: 28px 36px 20px; border-bottom: 1px solid #F1EDF8;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="left" style="vertical-align: middle;">
                    <table role="presentation" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="background-color: #7655D9; border-radius: 9px; width: 34px; height: 34px; text-align: center; vertical-align: middle;">
                          <span style="font-size: 18px; line-height: 1;">⚡</span>
                        </td>
                        <td style="padding-left: 10px; vertical-align: middle;">
                          <span style="font-size: 18px; font-weight: 800; letter-spacing: -0.02em; color: #1A1528;">
                            Comment<span style="color: #936BFF;">2</span>DM
                          </span>
                        </td>
                      </tr>
                    </table>
                  </td>
                  <td align="right" style="vertical-align: middle;">
                    <span style="display: inline-block; background-color: #ECFDF5; color: #059669; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; padding: 5px 10px; border-radius: 100px;">
                      Security Alert
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 32px 36px 28px;">
              <div style="width: 48px; height: 48px; border-radius: 50%; background-color: #ECFDF5; border: 1.5px solid #A7F3D0; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 16px;">
                <span style="font-size: 22px; line-height: 1;">🛡️</span>
              </div>
              <h1 style="font-size: 21px; font-weight: 800; line-height: 1.3; margin: 0 0 10px; color: #1A1528;">
                Password Successfully Reset
              </h1>
              <p style="font-size: 14px; line-height: 1.6; color: #524C61; margin: 0 0 20px;">
                Hi ${safeName}, the password for your Comment2DM account (<strong>${to}</strong>) was just updated.
              </p>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #F8F6FD; border: 1px solid #EBE5FA; border-radius: 12px; margin-bottom: 22px;">
                <tr>
                  <td style="padding: 14px 18px; font-size: 13px; line-height: 1.55; color: #524C61;">
                    <strong style="color: #1A1528; display: block; margin-bottom: 4px;">Session Security:</strong>
                    For your security, all active sessions on other browsers and devices have been logged out. You can now log in using your new password.
                  </td>
                </tr>
              </table>

              <p style="font-size: 12px; line-height: 1.55; color: #DC2626; margin: 0; padding-top: 18px; border-top: 1px solid #F1EDF8;">
                <strong>Did not make this change?</strong> Please immediately secure your account or reach out to our team at <a href="mailto:support@comment2dm.com" style="color: #7655D9; font-weight: 600; text-decoration: underline;">support@comment2dm.com</a>.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #FBF9FE; padding: 22px 36px; border-top: 1px solid #F1EDF8; text-align: center;">
              <p style="font-size: 11px; color: #7A748A; margin: 0 0 4px; font-weight: 500;">
                © ${new Date().getFullYear()} Comment2DM by VI TECH Limited. All rights reserved.
              </p>
              <p style="font-size: 11px; color: #9A94AA; margin: 0;">
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

  return sendEmail({
    to,
    subject: `Security Alert: Your Comment2DM password was updated`,
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
