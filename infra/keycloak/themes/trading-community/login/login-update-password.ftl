<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=true; section>
  <#if section = "header">${msg("updatePasswordTitle")}
  <#elseif section = "form">
    <p class="tc-notice">Trading Community uses Keycloak for account security. Changing your password signs out other sessions.</p>
    <form action="${url.loginAction}" method="post" id="kc-passwd-update-form">
      <input type="hidden" name="logout-sessions" value="on" />
      <div class="tc-field"><label for="password-new">${msg("passwordNew")}</label><input id="password-new" name="password-new" type="password" autocomplete="new-password" required autofocus /></div>
      <div class="tc-field"><label for="password-confirm">${msg("passwordConfirm")}</label><input id="password-confirm" name="password-confirm" type="password" autocomplete="new-password" required /></div>
      <button class="tc-submit" type="submit" name="login">${msg("doSubmit")}</button>
    </form>
  </#if>
</@layout.registrationLayout>
