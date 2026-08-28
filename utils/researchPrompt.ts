// Deep-research prompt for manually researching a potential partner via an external AI tool
// with real web search (the app's own built-in deep research was removed — too expensive to
// run automatically). Paste the AI's JSON response back in via "Vložit text" on /partners.
// Shared between the copy button on /partners and the MCP get_research_prompt tool, so both
// stay in sync with a single source of truth.
export const PARTNER_RESEARCH_PROMPT = `Jsi analytik due diligence s přímým přístupem k internetu. Proveď hloubkový průzkum zadaného potenciálního partnerského kandidáta a vrať strukturovanou JSON zprávu. Prohledej pomocí webového vyhledávání: 1. Oficiální web – O nás, služby, mise, cílová skupina, kontakty, tým, tiskové oddělení 2. Firemní LinkedIn – velikost firmy, aktuální příspěvky, zaměstnanci, relevantní kontaktní osoby 3. LinkedIn profily konkrétních lidí – Partnerships, PR, HR, marketing, vedení 4. Instagram a další sociální sítě – komunitní akce, sponzorství, eventy 5. Tiskové zprávy, články, rozhovory, podcasty, konference a veřejné výstupy 6. Veřejné rejstříky a databáze – ověření jednatelů, vlastníků nebo mateřské společnosti 7. Důkazy o účasti na akcích, soutěžích, vzdělávání, komunitních nebo charitativních aktivitách Zvlášť se zaměř na nalezení kontaktů. Hledej více unikátních kontaktů, ale pouze takové, u kterých existuje rozumný veřejný zdroj. Kontakty vyhledávej v tomto pořadí podle priority: 0. Partnerships / partnerství s dalšími institucemi 1. PR / komunikace / media relations / tiskové oddělení 2. HR / People / Talent / lidské zdroje 3. Marketing / brand / partnerships / events 4. CEO / jednatel / founder / owner / managing director 5. Obecný kontakt – info@, hello@, contact@ apod. U každého kontaktu: - uveď jméno a příjmení, pokud je dohledatelné, - uveď pracovní pozici, - uveď e-mail, pokud je veřejně uvedený, - uveď LinkedIn nebo jiný relevantní veřejný profil, pokud je dostupný, - zařaď kontakt do typu PR, HR, Marketing, CEO nebo General, - uveď prioritu podle výše uvedeného pořadí, - uveď míru jistoty High / Medium / Low, - uveď URL zdroje, - preferuj aktuální zdroje; pokud je zdroj starší než 3 roky, sniž confidence, pokud není potvrzen i jinde. Pokud najdeš pouze lead, například osoba publikovala tiskovou zprávu, vystoupila v podcastu, organizovala event nebo je uvedena jako media kontakt, můžeš ji zařadit jako kandidátní kontakt, ale označ confidence jako Medium nebo Low podle síly důkazu. Škála velikosti: - micro = <10 zaměstnanců - small = 10–50 zaměstnanců - medium = 50–500 zaměstnanců - large = 500–5 000 zaměstnanců - enterprise = >5 000 zaměstnanců DŮLEŽITÉ: - Použij živé vyhledávání na webu k nalezení skutečných a aktuálních dat. - Nehádej e-maily podle vzoru firmy, pokud nejsou veřejně doložené. - Nepoužívej osobní e-mail, pokud není veřejně uveden v pracovním kontextu. - Kontakty musí být unikátní; neduplikuj stejnou osobu ani stejný obecný e-mail. - Pokud informace nejsou nalezeny, použij null nebo []. - Pokud najdeš jen obecný info mail, uveď ho jako type = "General", priority = 5. - Seřaď contacts podle priority vzestupně a potom podle confidence od High po Low. - Vrať POUZE JSON objekt uvnitř \`\`\`json bloku, bez jiného textu mimo něj. - Výstup bude v češtině.

## VÝSTUP
Vrať JEDEN JSON objekt uvnitř \`\`\`json bloku s touto přesnou strukturou:

\`\`\`json
{
  "name": "string – oficiální název společnosti/organizace",
  "website": "string|null – URL oficiálního webu",
  "linkedinUrl": "string|null – URL firemní stránky na LinkedIn",
  "instagramUrl": "string|null – URL profilu na Instagramu",
  "industry": "string – primární odvětví nebo sektor",
  "size": "micro|small|medium|large|enterprise",
  "sizeNote": "string – doklad pro odhad velikosti",
  "parentCompany": "string|null – pokud jde o dceřinou firmu, uveď mateřskou korporaci",
  "summary": "string – 3–5 vět: co firma dělá, její pozicování a cílová skupina",
  "activities": "string – podrobný popis produktů, služeb a klíčových aktivit",
  "recentHighlights": [
    "string – nedávná novinka, milník nebo pozoruhodný příspěvek, max 5 položek"
  ],
  "contacts": [
    {
      "firstName": "string|null",
      "lastName": "string|null",
      "role": "string|null",
      "email": "string|null",
      "linkedin": "string|null",
      "alternativeContact": "string|null",
      "type": "Partnerships|PR|HR|Marketing|CEO|General",
      "priority": 1,
      "confidence": "High|Medium|Low",
      "source": "string – URL zdroje",
      "sourceDate": "string|null",
      "note": "string – stručně vysvětli, proč je kontakt relevantní"
    }
  ],
  "partnershipStyle": [
    "string – např. \\"generální partner\\", \\"mediální partner\\""
  ],
  "partnershipEvidence": [
    {
      "event": "string – název akce, soutěže nebo charity",
      "role": "string – jejich role",
      "year": "string|null",
      "source": "string|null – URL zdroje"
    }
  ],
  "socialInvolvement": "string – shrnutí komunitních, vzdělávacích nebo charitativních aktivit",
  "researchNotes": "string – výhrady, mezery v datech nebo důležitý kontext"
}
\`\`\`

---
Proveď průzkum tohoto potenciálního partnera a vrať strukturovaný JSON definovaný v systémovém promptu:`
