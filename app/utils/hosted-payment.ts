export interface HostedPaymentRedirect {
  actionUrl: string
  method: 'POST'
  fields: Record<string, string>
}

export function submitHostedPayment(redirect: HostedPaymentRedirect) {
  const form = document.createElement('form')
  form.method = redirect.method
  form.action = redirect.actionUrl
  form.hidden = true
  for (const [name, value] of Object.entries(redirect.fields)) {
    const input = document.createElement('input')
    input.type = 'hidden'
    input.name = name
    input.value = value
    form.appendChild(input)
  }
  document.body.appendChild(form)
  form.submit()
}
