import type { Metadata } from "next";
import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";


const LAST_UPDATED = "August 03, 2026";

/**
 * PLACEHOLDERS — the source document left these lists empty. They must be
 * filled before this page is treated as published legal text.
 */
const SERVER_LOCATIONS = "[INSERT COUNTRIES]";
const DISCLOSED_CATEGORIES = "[INSERT CATEGORIES]";

/**
 * Addresses carried over verbatim from the source document. Two different
 * ones appear in it: the general contact address, and a separate one for
 * questions about the notice itself (section 15).
 */
const CONTACT_EMAIL = "withasilbeck@gmail.com";
const NOTICE_EMAIL = "nicknameggco@gmail.com";
const TELEGRAM_HANDLE = "with_asilbeck";

/**
 * Neither of these pages exists yet, and the first is on a domain we do not
 * own (the site is netherite.uz). Rendered as plain text rather than as dead
 * links until they resolve.
 */
const DSAR_PORTAL = "netherite.com/personal";
const CONTACT_PAGE = "netherite.uz/contact";

export const metadata: Metadata = {
  title: "Privacy Policy — Netherite",
  description:
    "How Netherite accesses, collects, stores, uses, and shares your personal information when you use our services.",
};

const tableOfContents = [
  { id: "infocollect", label: "WHAT INFORMATION DO WE COLLECT?" },
  { id: "infouse", label: "HOW DO WE PROCESS YOUR INFORMATION?" },
  {
    id: "legalbases",
    label:
      "WHAT LEGAL BASES DO WE RELY ON TO PROCESS YOUR PERSONAL INFORMATION?",
  },
  {
    id: "whoshare",
    label: "WHEN AND WITH WHOM DO WE SHARE YOUR PERSONAL INFORMATION?",
  },
  { id: "cookies", label: "DO WE USE COOKIES AND OTHER TRACKING TECHNOLOGIES?" },
  { id: "ai", label: "DO WE OFFER ARTIFICIAL INTELLIGENCE-BASED PRODUCTS?" },
  { id: "sociallogins", label: "HOW DO WE HANDLE YOUR SOCIAL LOGINS?" },
  { id: "intltransfers", label: "IS YOUR INFORMATION TRANSFERRED INTERNATIONALLY?" },
  { id: "inforetain", label: "HOW LONG DO WE KEEP YOUR INFORMATION?" },
  { id: "infosafe", label: "HOW DO WE KEEP YOUR INFORMATION SAFE?" },
  { id: "privacyrights", label: "WHAT ARE YOUR PRIVACY RIGHTS?" },
  { id: "dnt", label: "CONTROLS FOR DO-NOT-TRACK FEATURES" },
  {
    id: "uslaws",
    label: "DO UNITED STATES RESIDENTS HAVE SPECIFIC PRIVACY RIGHTS?",
  },
  { id: "policyupdates", label: "DO WE MAKE UPDATES TO THIS NOTICE?" },
  { id: "contact", label: "HOW CAN YOU CONTACT US ABOUT THIS NOTICE?" },
  {
    id: "request",
    label: "HOW CAN YOU REVIEW, UPDATE, OR DELETE THE DATA WE COLLECT FROM YOU?",
  },
];

type InfoCategory = {
  category: string;
  /** `null` renders the italic "Not specified" cell — empty in the source. */
  examples: string | null;
  collected: string;
};

const infoCategories: InfoCategory[] = [
  {
    category: "A. Identifiers",
    examples:
      "Contact details, such as real name, alias, postal address, telephone or mobile contact number, unique personal identifier, online identifier, Internet Protocol address, email address, and account name",
    collected: "NO",
  },
  {
    category:
      "B. Personal information as defined in the California Customer Records statute",
    examples:
      "Name, contact information, education, employment, employment history, and financial information",
    collected: "NO",
  },
  {
    category:
      "C. Protected classification characteristics under state or federal law",
    examples:
      "Gender, age, date of birth, race and ethnicity, national origin, marital status, and other demographic data",
    collected: "NO",
  },
  {
    category: "D. Commercial information",
    examples:
      "Transaction information, purchase history, financial details, and payment information",
    collected: "NO",
  },
  {
    category: "E. Biometric information",
    examples: "Fingerprints and voiceprints",
    collected: "NO",
  },
  {
    category: "F. Internet or other similar network activity",
    examples:
      "Browsing history, search history, online behavior, interest data, and interactions with our and other websites, applications, systems, and advertisements",
    collected: "NO",
  },
  {
    category: "G. Geolocation data",
    examples: "Device location",
    collected: "NO",
  },
  {
    category: "H. Audio, electronic, sensory, or similar information",
    examples:
      "Images and audio, video or call recordings created in connection with our business activities",
    collected: "NO",
  },
  {
    category: "I. Professional or employment-related information",
    examples:
      "Business contact details in order to provide you our Services at a business level or job title, work history, and professional qualifications if you apply for a job with us",
    collected: "NO",
  },
  {
    category: "J. Education Information",
    examples: "Student records and directory information",
    collected: "NO",
  },
  {
    category: "K. Inferences drawn from collected personal information",
    examples:
      "Inferences drawn from any of the collected personal information listed above to create a profile or summary about, for example, an individual’s preferences and characteristics",
    collected: "NO",
  },
  {
    category: "L. Sensitive personal Information",
    examples: null,
    collected: "NO",
  },
];

const linkClassName =
  "underline underline-offset-4 transition-colors hover:text-foreground";

/** Numbered rule between sections, matching the border-led rhythm elsewhere. */
function Section({
  id,
  number,
  title,
  children,
}: {
  id: string;
  number: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-8 border-t border-border pt-10">
      <h2 className="m-0 flex items-baseline gap-3 text-xl font-semibold tracking-[-0.01em] sm:text-2xl">
        <span
          aria-hidden
          className="shrink-0 font-mono text-base text-muted-foreground"
        >
          {number}
        </span>
        <span>{title}</span>
      </h2>
      <div className="mt-5 flex flex-col gap-4 text-base leading-[1.7] text-muted-foreground">
        {children}
      </div>
    </section>
  );
}

function Subheading({ children }: { children: ReactNode }) {
  return (
    <h3 className="mt-3 text-base font-semibold text-foreground">{children}</h3>
  );
}

/** The italic "In Short:" precis that opens most sections of the notice. */
function InShort({ children }: { children: ReactNode }) {
  return (
    <p className="italic">
      <strong className="font-semibold text-foreground">In Short:</strong>{" "}
      {children}
    </p>
  );
}

function Bullets({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-2 pl-5">{children}</ul>;
}

function Term({ children }: { children: ReactNode }) {
  return <span className="font-semibold text-foreground">{children}</span>;
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={linkClassName}
    >
      {children}
    </a>
  );
}

/** Internal cross-reference to another section of this notice. */
function Ref({ id, children }: { id: string; children: ReactNode }) {
  return (
    <a href={`#${id}`} className={linkClassName}>
      {children}
    </a>
  );
}

function CookieNotice() {
  return (
    <Link href="/cookie" className={linkClassName}>
      netherite.uz/cookie
    </Link>
  );
}

export default function PrivacyPolicyPage() {
  return (
    <div
      className="flex min-h-screen w-full flex-col bg-background font-sans text-foreground"
    >
      <header className="flex items-center justify-between border-b border-border px-6 py-7 sm:px-14">
        <Link href="/" className="flex items-center gap-3">
          <Image
            src="/netherite-mark.png"
            alt="Netherite"
            width={34}
            height={34}
            className="h-[34px] w-[34px] object-contain dark:invert"
          />
          <span className="text-[34px] leading-none translate-y-[0.11em] font-brand">NETHERITE</span>
        </Link>
        <Link
          href="/"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Back home
        </Link>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-14 sm:px-8 md:py-20">
        <div className="mb-4 text-sm font-medium text-muted-foreground">Legal</div>
        <h1 className="m-0 text-[clamp(30px,4.5vw,46px)] font-semibold leading-[1.1] tracking-[-0.02em]">
          Privacy Policy
        </h1>
        <p className="mt-5 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Last updated:</span>{" "}
          {LAST_UPDATED}
        </p>

        <div className="mt-6 flex flex-col gap-4 text-base leading-[1.7] text-muted-foreground">
          <p>
            This Privacy Notice for Netherite AI (&ldquo;<Term>we</Term>,&rdquo;
            &ldquo;<Term>us</Term>,&rdquo; or &ldquo;<Term>our</Term>&rdquo;),
            describes how and why we might access, collect, store, use, and/or
            share (&ldquo;<Term>process</Term>&rdquo;) your personal information
            when you use our services (&ldquo;<Term>Services</Term>&rdquo;),
            including when you:
          </p>
          <Bullets>
            <li className="pl-1">
              Visit our website at{" "}
              <ExternalLink href="http://www.netherite.uz">
                http://www.netherite.uz
              </ExternalLink>{" "}
              or any website of ours that links to this Privacy Notice
            </li>
            <li className="pl-1">
              Engage with us in other related ways, including any marketing or
              events
            </li>
          </Bullets>
          <p>
            <Term>Questions or concerns?</Term> Reading this Privacy Notice will
            help you understand your privacy rights and choices. We are
            responsible for making decisions about how your personal information
            is processed. If you do not agree with our policies and practices,
            please do not use our Services. If you still have any questions or
            concerns, please contact us at{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className={linkClassName}>
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </div>

        <div className="mt-14 flex flex-col gap-10">
          <section className="border-t border-border pt-10">
            <h2 className="m-0 text-xl font-semibold tracking-[-0.01em] sm:text-2xl">
              Summary of key points
            </h2>
            <div className="mt-5 flex flex-col gap-4 text-base leading-[1.7] text-muted-foreground">
              <p className="italic">
                <Term>
                  This summary provides key points from our Privacy Notice, but
                  you can find out more details about any of these topics by
                  clicking the link following each key point or by using our
                  table of contents below to find the section you are looking
                  for.
                </Term>
              </p>
              <p>
                <Term>What personal information do we process?</Term> When you
                visit, use, or navigate our Services, we may process personal
                information depending on how you interact with us and the
                Services, the choices you make, and the products and features you
                use. Learn more about{" "}
                <Ref id="infocollect">
                  personal information you disclose to us
                </Ref>
                .
              </p>
              <p>
                <Term>Do we process any sensitive personal information?</Term>{" "}
                Some of the information may be considered &ldquo;special&rdquo;
                or &ldquo;sensitive&rdquo; in certain jurisdictions, for example
                your racial or ethnic origins, sexual orientation, and religious
                beliefs. We may process sensitive personal information when
                necessary with your consent or as otherwise permitted by
                applicable law. Learn more about{" "}
                <Ref id="infocollect">sensitive information we process</Ref>.
              </p>
              <p>
                <Term>Do we collect any information from third parties?</Term> We
                do not collect any information from third parties.
              </p>
              <p>
                <Term>How do we process your information?</Term> We process your
                information to provide, improve, and administer our Services,
                communicate with you, for security and fraud prevention, and to
                comply with law. We may also process your information for other
                purposes with your consent. We process your information only when
                we have a valid legal reason to do so. Learn more about{" "}
                <Ref id="infouse">how we process your information</Ref>.
              </p>
              <p>
                <Term>
                  In what situations and with which parties do we share personal
                  information?
                </Term>{" "}
                We may share information in specific situations and with specific
                third parties. Learn more about{" "}
                <Ref id="whoshare">
                  when and with whom we share your personal information
                </Ref>
                .
              </p>
              <p>
                <Term>How do we keep your information safe?</Term> We have
                adequate organizational and technical processes and procedures in
                place to protect your personal information. However, no
                electronic transmission over the internet or information storage
                technology can be guaranteed to be 100% secure, so we cannot
                promise or guarantee that hackers, cybercriminals, or other
                unauthorized third parties will not be able to defeat our
                security and improperly collect, access, steal, or modify your
                information. Learn more about{" "}
                <Ref id="infosafe">how we keep your information safe</Ref>.
              </p>
              <p>
                <Term>What are your rights?</Term> Depending on where you are
                located geographically, the applicable privacy law may mean you
                have certain rights regarding your personal information. Learn
                more about <Ref id="privacyrights">your privacy rights</Ref>.
              </p>
              <p>
                <Term>How do you exercise your rights?</Term> The easiest way to
                exercise your rights is by visiting{" "}
                <Term>{DSAR_PORTAL}</Term>, or by contacting us. We will consider
                and act upon any request in accordance with applicable data
                protection laws.
              </p>
            </div>
          </section>

          <section className="border-t border-border pt-10">
            <h2 className="m-0 text-xl font-semibold tracking-[-0.01em] sm:text-2xl">
              Table of contents
            </h2>
            <ol className="mt-5 list-decimal space-y-2 pl-5 text-base leading-[1.7] text-muted-foreground">
              {tableOfContents.map(({ id, label }) => (
                <li key={id} className="pl-1">
                  <Ref id={id}>{label}</Ref>
                </li>
              ))}
            </ol>
          </section>

          <Section id="infocollect" number="01" title="What information do we collect?">
            <Subheading>Personal information you disclose to us</Subheading>
            <InShort>
              <em>We collect personal information that you provide to us.</em>
            </InShort>
            <p>
              We collect personal information that you voluntarily provide to us
              when you register on the Services, express an interest in obtaining
              information about us or our products and Services, when you
              participate in activities on the Services, or otherwise when you
              contact us.
            </p>
            <p>
              <Term>Personal Information Provided by You.</Term> The personal
              information that we collect depends on the context of your
              interactions with us and the Services, the choices you make, and the
              products and features you use. The personal information we collect
              may include the following:
            </p>
            <Bullets>
              <li className="pl-1">names</li>
              <li className="pl-1">email addresses</li>
              <li className="pl-1">usernames</li>
              <li className="pl-1">contact or authentication data</li>
              <li className="pl-1">billing addresses</li>
              <li className="pl-1">debit/credit card numbers</li>
            </Bullets>
            <p>
              <Term>Sensitive Information.</Term> When necessary, with your
              consent or as otherwise permitted by applicable law, we process the
              following categories of sensitive information:
            </p>
            <Bullets>
              <li className="pl-1">financial data</li>
              <li className="pl-1">biometric data</li>
            </Bullets>
            <p>
              <Term>Payment Data.</Term> We may collect data necessary to process
              your payment if you choose to make purchases, such as your payment
              instrument number, and the security code associated with your
              payment instrument. All payment data is handled and stored by Lemon
              Squeezy. You may find their privacy notice link(s) here:{" "}
              <ExternalLink href="https://www.lemonsqueezy.com/privacy">
                https://www.lemonsqueezy.com/privacy
              </ExternalLink>
              .
            </p>
            <p>
              <Term>Social Media Login Data.</Term> We may provide you with the
              option to register with us using your existing social media account
              details, like your Facebook, X, or other social media account. If
              you choose to register in this way, we will collect certain profile
              information about you from the social media provider, as described
              in the section called &ldquo;
              <Ref id="sociallogins">HOW DO WE HANDLE YOUR SOCIAL LOGINS?</Ref>
              &rdquo; below.
            </p>
            <p>
              All personal information that you provide to us must be true,
              complete, and accurate, and you must notify us of any changes to
              such personal information.
            </p>

            <Subheading>Information automatically collected</Subheading>
            <InShort>
              <em>
                Some information — such as your Internet Protocol (IP) address
                and/or browser and device characteristics — is collected
                automatically when you visit our Services.
              </em>
            </InShort>
            <p>
              We automatically collect certain information when you visit, use, or
              navigate the Services. This information does not reveal your
              specific identity (like your name or contact information) but may
              include device and usage information, such as your IP address,
              browser and device characteristics, operating system, language
              preferences, referring URLs, device name, country, location,
              information about how and when you use our Services, and other
              technical information. This information is primarily needed to
              maintain the security and operation of our Services, and for our
              internal analytics and reporting purposes.
            </p>
            <p>
              Like many businesses, we also collect information through cookies
              and similar technologies. You can find out more about this in our
              Cookie Notice: <CookieNotice />.
            </p>
            <p>The information we collect includes:</p>
            <Bullets>
              <li className="pl-1">
                <em>Log and Usage Data.</em> Log and usage data is
                service-related, diagnostic, usage, and performance information
                our servers automatically collect when you access or use our
                Services and which we record in log files. Depending on how you
                interact with us, this log data may include your IP address,
                device information, browser type, and settings and information
                about your activity in the Services (such as the date/time stamps
                associated with your usage, pages and files viewed, searches, and
                other actions you take such as which features you use), device
                event information (such as system activity, error reports
                (sometimes called &ldquo;crash dumps&rdquo;), and hardware
                settings).
              </li>
            </Bullets>

            <Subheading>Google API</Subheading>
            <p>
              Our use of information received from Google APIs will adhere to{" "}
              <ExternalLink href="https://developers.google.com/terms/api-services-user-data-policy">
                Google API Services User Data Policy
              </ExternalLink>
              , including the{" "}
              <ExternalLink href="https://developers.google.com/terms/api-services-user-data-policy#limited-use">
                Limited Use requirements
              </ExternalLink>
              .
            </p>
          </Section>

          <Section id="infouse" number="02" title="How do we process your information?">
            <InShort>
              <em>
                We process your information to provide, improve, and administer
                our Services, communicate with you, for security and fraud
                prevention, and to comply with law. We process the personal
                information for the following purposes listed below. We may also
                process your information for other purposes only with your prior
                explicit consent.
              </em>
            </InShort>
            <p>
              <Term>
                We process your personal information for a variety of reasons,
                depending on how you interact with our Services, including:
              </Term>
            </p>
            <Bullets>
              <li className="pl-1">
                <Term>
                  To facilitate account creation and authentication and otherwise
                  manage user accounts.
                </Term>{" "}
                We may process your information so you can create and log in to
                your account, as well as keep your account in working order.
              </li>
              <li className="pl-1">
                <Term>
                  To deliver and facilitate delivery of services to the user.
                </Term>{" "}
                We may process your information to provide you with the requested
                service.
              </li>
              <li className="pl-1">
                <Term>To respond to user inquiries/offer support to users.</Term>{" "}
                We may process your information to respond to your inquiries and
                solve any potential issues you might have with the requested
                service.
              </li>
              <li className="pl-1">
                <Term>To send administrative information to you.</Term> We may
                process your information to send you details about our products
                and services, changes to our terms and policies, and other similar
                information.
              </li>
              <li className="pl-1">
                <Term>To fulfill and manage your orders.</Term> We may process
                your information to fulfill and manage your orders, payments,
                returns, and exchanges made through the Services.
              </li>
              <li className="pl-1">
                <Term>To deliver targeted advertising to you.</Term> We may
                process your information to develop and display personalized
                content and advertising tailored to your interests, location, and
                more. For more information see our Cookie Notice:{" "}
                <CookieNotice />.
              </li>
              <li className="pl-1">
                <Term>
                  To determine the effectiveness of our marketing and promotional
                  campaigns.
                </Term>{" "}
                We may process your information to better understand how to
                provide marketing and promotional campaigns that are most relevant
                to you.
              </li>
              <li className="pl-1">
                <Term>To save or protect an individual&rsquo;s vital interest.</Term>{" "}
                We may process your information when necessary to save or protect
                an individual&rsquo;s vital interest, such as to prevent harm.
              </li>
              <li className="pl-1">
                <Term>Checking for their codebase.</Term> To analyze
                user-submitted code, snippets, and connected GitHub repositories
                in order to identify and report security vulnerabilities.
              </li>
            </Bullets>
          </Section>

          <Section
            id="legalbases"
            number="03"
            title="What legal bases do we rely on to process your information?"
          >
            <InShort>
              <em>
                We only process your personal information when we believe it is
                necessary and we have a valid legal reason (i.e., legal basis) to
                do so under applicable law, like with your consent, to comply with
                laws, to provide you with services to enter into or fulfill our
                contractual obligations, to protect your rights, or to fulfill our
                legitimate business interests.
              </em>
            </InShort>
            <p className="italic">
              <Term>
                <u>If you are located in the EU or UK, this section applies to
                you.</u>
              </Term>
            </p>
            <p>
              The General Data Protection Regulation (GDPR) and UK GDPR require us
              to explain the valid legal bases we rely on in order to process your
              personal information. As such, we may rely on the following legal
              bases to process your personal information:
            </p>
            <Bullets>
              <li className="pl-1">
                <Term>Consent.</Term> We may process your information if you have
                given us permission (i.e., consent) to use your personal
                information for a specific purpose. You can withdraw your consent
                at any time. Learn more about{" "}
                <Ref id="privacyrights">withdrawing your consent</Ref>.
              </li>
              <li className="pl-1">
                <Term>Performance of a Contract.</Term> We may process your
                personal information when we believe it is necessary to fulfill
                our contractual obligations to you, including providing our
                Services or at your request prior to entering into a contract with
                you.
              </li>
              <li className="pl-1">
                <Term>Legitimate Interests.</Term> We may process your information
                when we believe it is reasonably necessary to achieve our
                legitimate business interests and those interests do not outweigh
                your interests and fundamental rights and freedoms. For example,
                we may process your personal information for some of the purposes
                described in order to:
                <ul className="mt-2 list-[circle] space-y-2 pl-5">
                  <li className="pl-1">
                    Develop and display personalized and relevant advertising
                    content for our users
                  </li>
                  <li className="pl-1">Support our marketing activities</li>
                </ul>
              </li>
              <li className="pl-1">
                <Term>Legal Obligations.</Term> We may process your information
                where we believe it is necessary for compliance with our legal
                obligations, such as to cooperate with a law enforcement body or
                regulatory agency, exercise or defend our legal rights, or disclose
                your information as evidence in litigation in which we are
                involved.
              </li>
              <li className="pl-1">
                <Term>Vital Interests.</Term> We may process your information
                where we believe it is necessary to protect your vital interests or
                the vital interests of a third party, such as situations involving
                potential threats to the safety of any person.
              </li>
            </Bullets>
            <p className="italic">
              <Term>
                <u>If you are located in Canada, this section applies to you.</u>
              </Term>
            </p>
            <p>
              We may process your information if you have given us specific
              permission (i.e., express consent) to use your personal information
              for a specific purpose, or in situations where your permission can be
              inferred (i.e., implied consent). You can{" "}
              <Ref id="privacyrights">withdraw your consent</Ref> at any time.
            </p>
            <p>
              In some exceptional cases, we may be legally permitted under
              applicable law to process your information without your consent,
              including, for example:
            </p>
            <Bullets>
              <li className="pl-1">
                If collection is clearly in the interests of an individual and
                consent cannot be obtained in a timely way
              </li>
              <li className="pl-1">
                For investigations and fraud detection and prevention
              </li>
              <li className="pl-1">
                For business transactions provided certain conditions are met
              </li>
              <li className="pl-1">
                If it is contained in a witness statement and the collection is
                necessary to assess, process, or settle an insurance claim
              </li>
              <li className="pl-1">
                For identifying injured, ill, or deceased persons and
                communicating with next of kin
              </li>
              <li className="pl-1">
                If we have reasonable grounds to believe an individual has been,
                is, or may be victim of financial abuse
              </li>
              <li className="pl-1">
                If it is reasonable to expect collection and use with consent
                would compromise the availability or the accuracy of the
                information and the collection is reasonable for purposes related
                to investigating a breach of an agreement or a contravention of
                the laws of Canada or a province
              </li>
              <li className="pl-1">
                If disclosure is required to comply with a subpoena, warrant,
                court order, or rules of the court relating to the production of
                records
              </li>
              <li className="pl-1">
                If it was produced by an individual in the course of their
                employment, business, or profession and the collection is
                consistent with the purposes for which the information was produced
              </li>
              <li className="pl-1">
                If the collection is solely for journalistic, artistic, or
                literary purposes
              </li>
              <li className="pl-1">
                If the information is publicly available and is specified by the
                regulations
              </li>
              <li className="pl-1">
                We may disclose de-identified information for approved research or
                statistics projects, subject to ethics oversight and
                confidentiality commitments
              </li>
            </Bullets>
          </Section>

          <Section
            id="whoshare"
            number="04"
            title="When and with whom do we share your personal information?"
          >
            <InShort>
              <em>
                We may share information in specific situations described in this
                section and/or with the following third parties.
              </em>
            </InShort>
            <p>
              <Term>
                Vendors, Consultants, and Other Third-Party Service Providers.
              </Term>{" "}
              We may share your data with third-party vendors, service providers,
              contractors, or agents (&ldquo;<Term>third parties</Term>&rdquo;)
              who perform services for us or on our behalf and require access to
              such information to do that work. We have contracts in place with our
              third parties, which are designed to help safeguard your personal
              information. This means that they cannot do anything with your
              personal information unless we have instructed them to do it. They
              will also not share your personal information with any organization
              apart from us. They also commit to protect the data they hold on our
              behalf and to retain it for the period we instruct.
            </p>
            <p>
              The third parties we may share personal information with are as
              follows:
            </p>
            <Bullets>
              <li className="pl-1">
                <Term>AI Service Providers</Term>
                <div className="mt-1">Google Cloud AI and Anthropic</div>
              </li>
              <li className="pl-1">
                <Term>Allow Users to Connect to Their Third-Party Accounts</Term>
                <div className="mt-1">Google account and Github account</div>
              </li>
              <li className="pl-1">
                <Term>User Account Registration and Authentication</Term>
                <div className="mt-1">Google OAuth 2.0 and GitHub OAuth</div>
              </li>
              <li className="pl-1">
                <Term>Web and Mobile Analytics</Term>
                <div className="mt-1">Google Analytics</div>
              </li>
            </Bullets>
            <p>
              We also may need to share your personal information in the following
              situations:
            </p>
            <Bullets>
              <li className="pl-1">
                <Term>Business Transfers.</Term> We may share or transfer your
                information in connection with, or during negotiations of, any
                merger, sale of company assets, financing, or acquisition of all or
                a portion of our business to another company.
              </li>
            </Bullets>
          </Section>

          <Section
            id="cookies"
            number="05"
            title="Do we use cookies and other tracking technologies?"
          >
            <InShort>
              <em>
                We may use cookies and other tracking technologies to collect and
                store your information.
              </em>
            </InShort>
            <p>
              We may use cookies and similar tracking technologies (like web
              beacons and pixels) to gather information when you interact with our
              Services. Some online tracking technologies help us maintain the
              security of our Services and your account, prevent crashes, fix bugs,
              save your preferences, and assist with basic site functions.
            </p>
            <p>
              We also permit third parties and service providers to use online
              tracking technologies on our Services for analytics and advertising,
              including to help manage and display advertisements or to tailor
              advertisements to your interests. The third parties and service
              providers use their technology to provide advertising about products
              and services tailored to your interests which may appear either on
              our Services or on other websites.
            </p>
            <p>
              To the extent these online tracking technologies are deemed to be a
              &ldquo;sale&rdquo;/&ldquo;sharing&rdquo; (which includes targeted
              advertising, as defined under the applicable laws) under applicable
              US state laws, you can opt out of these online tracking technologies
              by submitting a request as described below under section &ldquo;
              <Ref id="uslaws">
                DO UNITED STATES RESIDENTS HAVE SPECIFIC PRIVACY RIGHTS?
              </Ref>
              &rdquo;
            </p>
            <p>
              Specific information about how we use such technologies and how you
              can refuse certain cookies is set out in our Cookie Notice:{" "}
              <CookieNotice />.
            </p>

            <Subheading>Google Analytics</Subheading>
            <p>
              We may share your information with Google Analytics to track and
              analyze the use of the Services. The Google Analytics Advertising
              Features that we may use include: Google Analytics Demographics and
              Interests Reporting, Remarketing with Google Analytics and Google
              Display Network Impressions Reporting. To opt out of being tracked by
              Google Analytics across the Services, visit{" "}
              <ExternalLink href="https://tools.google.com/dlpage/gaoptout">
                https://tools.google.com/dlpage/gaoptout
              </ExternalLink>
              . You can opt out of Google Analytics Advertising Features through{" "}
              <ExternalLink href="https://adssettings.google.com/">
                Ads Settings
              </ExternalLink>{" "}
              and Ad Settings for mobile apps. Other opt out means include{" "}
              <ExternalLink href="http://optout.networkadvertising.org/">
                http://optout.networkadvertising.org/
              </ExternalLink>{" "}
              and{" "}
              <ExternalLink href="http://www.networkadvertising.org/mobile-choice">
                http://www.networkadvertising.org/mobile-choice
              </ExternalLink>
              . For more information on the privacy practices of Google, please
              visit the{" "}
              <ExternalLink href="https://policies.google.com/privacy">
                Google Privacy &amp; Terms page
              </ExternalLink>
              .
            </p>
          </Section>

          <Section
            id="ai"
            number="06"
            title="Do we offer artificial intelligence-based products?"
          >
            <InShort>
              <em>
                We offer products, features, or tools powered by artificial
                intelligence, machine learning, or similar technologies.
              </em>
            </InShort>
            <p>
              As part of our Services, we offer products, features, or tools
              powered by artificial intelligence, machine learning, or similar
              technologies (collectively, &ldquo;AI Products&rdquo;). These tools
              are designed to enhance your experience and provide you with
              innovative solutions. The terms in this Privacy Notice govern your
              use of the AI Products within our Services.
            </p>

            <Subheading>Use of AI Technologies</Subheading>
            <p>
              We provide the AI Products through third-party service providers
              (&ldquo;AI Service Providers&rdquo;), including Anthropic and Google
              Cloud AI. As outlined in this Privacy Notice, your input, output, and
              personal information will be shared with and processed by these AI
              Service Providers to enable your use of our AI Products for purposes
              outlined in &ldquo;
              <Ref id="legalbases">
                WHAT LEGAL BASES DO WE RELY ON TO PROCESS YOUR PERSONAL
                INFORMATION?
              </Ref>
              &rdquo; You must not use the AI Products in any way that violates the
              terms or policies of any AI Service Provider.
            </p>

            <Subheading>Our AI Products</Subheading>
            <p>Our AI Products are designed for the following functions:</p>
            <Bullets>
              <li className="pl-1">AI applications</li>
            </Bullets>

            <Subheading>How We Process Your Data Using AI</Subheading>
            <p>
              All personal information processed using our AI Products is handled
              in line with our Privacy Notice and our agreement with third parties.
              This ensures high security and safeguards your personal information
              throughout the process, giving you peace of mind about your
              data&rsquo;s safety.
            </p>
          </Section>

          <Section
            id="sociallogins"
            number="07"
            title="How do we handle your social logins?"
          >
            <InShort>
              <em>
                If you choose to register or log in to our Services using a social
                media account, we may have access to certain information about you.
              </em>
            </InShort>
            <p>
              Our Services offer you the ability to register and log in using your
              third-party social media account details (like your Facebook or X
              logins). Where you choose to do this, we will receive certain profile
              information about you from your social media provider. The profile
              information we receive may vary depending on the social media
              provider concerned, but will often include your name, email address,
              friends list, and profile picture, as well as other information you
              choose to make public on such a social media platform.
            </p>
            <p>
              We will use the information we receive only for the purposes that are
              described in this Privacy Notice or that are otherwise made clear to
              you on the relevant Services. Please note that we do not control, and
              are not responsible for, other uses of your personal information by
              your third-party social media provider. We recommend that you review
              their privacy notice to understand how they collect, use, and share
              your personal information, and how you can set your privacy
              preferences on their sites and apps.
            </p>
          </Section>

          <Section
            id="intltransfers"
            number="08"
            title="Is your information transferred internationally?"
          >
            <InShort>
              <em>
                We may transfer, store, and process your information in countries
                other than your own.
              </em>
            </InShort>
            <p>
              Our servers are located in {SERVER_LOCATIONS}. Regardless of your
              location, please be aware that your information may be transferred
              to, stored by, and processed by us in our facilities and in the
              facilities of the third parties with whom we may share your personal
              information (see &ldquo;
              <Ref id="whoshare">
                WHEN AND WITH WHOM DO WE SHARE YOUR PERSONAL INFORMATION?
              </Ref>
              &rdquo; above), including facilities in {SERVER_LOCATIONS} and other
              countries.
            </p>
            <p>
              If you are a resident in the European Economic Area (EEA), United
              Kingdom (UK), or Switzerland, then these countries may not
              necessarily have data protection laws or other similar laws as
              comprehensive as those in your country. However, we will take all
              necessary measures to protect your personal information in accordance
              with this Privacy Notice and applicable law.
            </p>
          </Section>

          <Section
            id="inforetain"
            number="09"
            title="How long do we keep your information?"
          >
            <InShort>
              <em>
                We keep your information for as long as necessary to fulfill the
                purposes outlined in this Privacy Notice unless otherwise required
                by law.
              </em>
            </InShort>
            <p>
              We will only keep your personal information for as long as it is
              necessary for the purposes set out in this Privacy Notice, unless a
              longer retention period is required or permitted by law (such as tax,
              accounting, or other legal requirements). No purpose in this notice
              will require us keeping your personal information for longer than one
              (1) month past the termination of the user&rsquo;s account.
            </p>
            <p>
              When we have no ongoing legitimate business need to process your
              personal information, we will either delete or anonymize such
              information, or, if this is not possible (for example, because your
              personal information has been stored in backup archives), then we
              will securely store your personal information and isolate it from any
              further processing until deletion is possible.
            </p>
          </Section>

          <Section
            id="infosafe"
            number="10"
            title="How do we keep your information safe?"
          >
            <InShort>
              <em>
                We aim to protect your personal information through a system of
                organizational and technical security measures.
              </em>
            </InShort>
            <p>
              We have implemented appropriate and reasonable technical and
              organizational security measures designed to protect the security of
              any personal information we process. However, despite our safeguards
              and efforts to secure your information, no electronic transmission
              over the Internet or information storage technology can be guaranteed
              to be 100% secure, so we cannot promise or guarantee that hackers,
              cybercriminals, or other unauthorized third parties will not be able
              to defeat our security and improperly collect, access, steal, or
              modify your information. Although we will do our best to protect your
              personal information, transmission of personal information to and
              from our Services is at your own risk. You should only access the
              Services within a secure environment.
            </p>
          </Section>

          <Section
            id="privacyrights"
            number="11"
            title="What are your privacy rights?"
          >
            <InShort>
              <em>
                Depending on your state of residence in the US or in some regions,
                such as the European Economic Area (EEA), United Kingdom (UK),
                Switzerland, and Canada, you have rights that allow you greater
                access to and control over your personal information. You may
                review, change, or terminate your account at any time, depending on
                your country, province, or state of residence.
              </em>
            </InShort>
            <p>
              In some regions (like the EEA, UK, Switzerland, and Canada), you have
              certain rights under applicable data protection laws. These may
              include the right (i) to request access and obtain a copy of your
              personal information, (ii) to request rectification or erasure; (iii)
              to restrict the processing of your personal information; (iv) if
              applicable, to data portability; and (v) not to be subject to
              automated decision-making. If a decision that produces legal or
              similarly significant effects is made solely by automated means, we
              will inform you, explain the main factors, and offer a simple way to
              request human review. In certain circumstances, you may also have the
              right to object to the processing of your personal information. You
              can make such a request by contacting us by using the contact details
              provided in the section &ldquo;
              <Ref id="contact">HOW CAN YOU CONTACT US ABOUT THIS NOTICE?</Ref>
              &rdquo; below.
            </p>
            <p>
              We will consider and act upon any request in accordance with
              applicable data protection laws.
            </p>
            <p>
              If you are located in the UK and are unhappy with how we have handled
              your personal information, you can make a complaint directly to us.
              This is in addition to the rights you have under the UK General Data
              Protection Regulation and the Data Protection Act 2018.
            </p>
            <p>How to contact us:</p>
            <Bullets>
              <li className="pl-1">
                <Term>Online:</Term> {CONTACT_PAGE}
              </li>
              <li className="pl-1">
                <Term>Email:</Term>{" "}
                <a href={`mailto:${CONTACT_EMAIL}`} className={linkClassName}>
                  {CONTACT_EMAIL}
                </a>
              </li>
              <li className="pl-1">
                <Term>Post:</Term> See &ldquo;
                <Ref id="contact">HOW CAN YOU CONTACT US ABOUT THIS NOTICE?</Ref>
                &rdquo;
              </li>
            </Bullets>
            <p>What happens after you complain</p>
            <Bullets>
              <li className="pl-1">
                We will acknowledge your complaint within 30 days of receiving it.
              </li>
              <li className="pl-1">
                We will investigate without unjustifiable or excessive delay.
              </li>
              <li className="pl-1">
                We will keep you informed of progress and explain the outcome.
              </li>
            </Bullets>
            <p>
              If you are not happy with our final response, you can refer your
              complaint to the Information Commissioner&rsquo;s Office, the UK
              supervisory authority.
            </p>
            <Bullets>
              <li className="pl-1">
                <Term>Website:</Term>{" "}
                <ExternalLink href="http://ico.org.uk/make-a-complaint">
                  ico.org.uk/make-a-complaint
                </ExternalLink>
              </li>
              <li className="pl-1">
                <Term>Helpline:</Term> 0303 123 1113
              </li>
              <li className="pl-1">
                <Term>Post:</Term> Information Commissioner&rsquo;s Office,
                Wycliffe House, Water Lane, Wilmslow, Cheshire, SK9 5AF
              </li>
            </Bullets>
            <p>
              If you are located in the EEA or UK and you believe we are unlawfully
              processing your personal information, you also have the right to
              complain to your{" "}
              <ExternalLink href="https://ec.europa.eu/justice/data-protection/bodies/authorities/index_en.htm">
                Member State data protection authority
              </ExternalLink>{" "}
              or{" "}
              <ExternalLink href="https://ico.org.uk/make-a-complaint/data-protection-complaints/data-protection-complaints/">
                UK data protection authority
              </ExternalLink>
              .
            </p>
            <p>
              If you are located in Switzerland, you may contact the{" "}
              <ExternalLink href="https://www.edoeb.admin.ch/edoeb/en/home.html">
                Federal Data Protection and Information Commissioner
              </ExternalLink>
              .
            </p>
            <p>
              <Term>
                <u>Withdrawing your consent:</u>
              </Term>{" "}
              If we are relying on your consent to process your personal
              information, which may be express and/or implied consent depending on
              the applicable law, you have the right to withdraw your consent at
              any time. You can withdraw your consent at any time by contacting us
              by using the contact details provided in the section &ldquo;
              <Ref id="contact">HOW CAN YOU CONTACT US ABOUT THIS NOTICE?</Ref>
              &rdquo; below or updating your preferences.
            </p>
            <p>
              However, please note that this will not affect the lawfulness of the
              processing before its withdrawal nor, when applicable law allows,
              will it affect the processing of your personal information conducted
              in reliance on lawful processing grounds other than consent.
            </p>
            <p>
              <Term>
                <u>Opting out of marketing and promotional communications:</u>
              </Term>{" "}
              You can unsubscribe from our marketing and promotional
              communications at any time by clicking on the unsubscribe link in the
              emails that we send, or by contacting us using the details provided
              in the section &ldquo;
              <Ref id="contact">HOW CAN YOU CONTACT US ABOUT THIS NOTICE?</Ref>
              &rdquo; below. You will then be removed from the marketing lists.
              However, we may still communicate with you — for example, to send you
              service-related messages that are necessary for the administration and
              use of your account, to respond to service requests, or for other
              non-marketing purposes.
            </p>

            <Subheading>Account Information</Subheading>
            <p>
              If you would at any time like to review or change the information in
              your account or terminate your account, you can:
            </p>
            <Bullets>
              <li className="pl-1">
                Log in to your account settings and update your user account.
              </li>
            </Bullets>
            <p>
              Upon your request to terminate your account, we will deactivate or
              delete your account and information from our active databases.
              However, we may retain some information in our files to prevent
              fraud, troubleshoot problems, assist with any investigations, enforce
              our legal terms and/or comply with applicable legal requirements.
            </p>
            <p>
              <Term>
                <u>Cookies and similar technologies:</u>
              </Term>{" "}
              Most Web browsers are set to accept cookies by default. If you
              prefer, you can usually choose to set your browser to remove cookies
              and to reject cookies. If you choose to remove cookies or reject
              cookies, this could affect certain features or services of our
              Services. For further information, please see our Cookie Notice:{" "}
              <CookieNotice />.
            </p>
            <p>
              If you have questions or comments about your privacy rights, you may
              email us at{" "}
              <a href={`mailto:${CONTACT_EMAIL}`} className={linkClassName}>
                {CONTACT_EMAIL}
              </a>
              .
            </p>
          </Section>

          <Section id="dnt" number="12" title="Controls for do-not-track features">
            <p>
              Most web browsers and some mobile operating systems and mobile
              applications include a Do-Not-Track (&ldquo;DNT&rdquo;) feature or
              setting you can activate to signal your privacy preference not to
              have data about your online browsing activities monitored and
              collected. At this stage, no uniform technology standard for
              recognizing and implementing DNT signals has been finalized. As such,
              we do not currently respond to DNT browser signals or any other
              mechanism that automatically communicates your choice not to be
              tracked online. If a standard for online tracking is adopted that we
              must follow in the future, we will inform you about that practice in a
              revised version of this Privacy Notice.
            </p>
            <p>
              California law requires us to let you know how we respond to web
              browser DNT signals. Because there currently is not an industry or
              legal standard for recognizing or honoring DNT signals, we do not
              respond to them at this time.
            </p>
          </Section>

          <Section
            id="uslaws"
            number="13"
            title="Do United States residents have specific privacy rights?"
          >
            <InShort>
              <em>
                If you are a resident of California, Colorado, Connecticut,
                Delaware, Florida, Indiana, Iowa, Kentucky, Maryland, Minnesota,
                Montana, Nebraska, New Hampshire, New Jersey, Oregon, Rhode Island,
                Tennessee, Texas, Utah, or Virginia, you may have the right to
                request access to and receive details about the personal
                information we maintain about you and how we have processed it,
                correct inaccuracies, get a copy of, or delete your personal
                information. You may also have the right to withdraw your consent
                to our processing of your personal information. These rights may be
                limited in some circumstances by applicable law. More information is
                provided below.
              </em>
            </InShort>

            <Subheading>Categories of Personal Information We Collect</Subheading>
            <p>
              The table below shows the categories of personal information we have
              collected in the past twelve (12) months. The table includes
              illustrative examples of each category and does not reflect the
              personal information we collect from you. For a comprehensive
              inventory of all personal information we process, please refer to the
              section &ldquo;
              <Ref id="infocollect">WHAT INFORMATION DO WE COLLECT?</Ref>&rdquo;
            </p>

            {/* Scrolls inside itself rather than pushing the page sideways on a
                narrow screen. */}
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                <caption className="sr-only">
                  Categories of personal information collected in the past twelve
                  months, with examples and whether each is collected.
                </caption>
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th scope="col" className="px-4 py-3 font-medium">
                      Category
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Examples
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Collected
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {infoCategories.map((row) => (
                    <tr
                      key={row.category}
                      className="border-b border-border align-top last:border-0"
                    >
                      <th
                        scope="row"
                        className="px-4 py-3 text-left font-semibold text-foreground"
                      >
                        {row.category}
                      </th>
                      <td className="px-4 py-3">
                        {row.examples ?? (
                          <em className="italic">Not specified</em>
                        )}
                      </td>
                      <td className="px-4 py-3 font-medium text-foreground">
                        {row.collected}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p>
              We may also collect other personal information outside of these
              categories through instances where you interact with us in person,
              online, or by phone or mail in the context of:
            </p>
            <Bullets>
              <li className="pl-1">
                Receiving help through our customer support channels;
              </li>
              <li className="pl-1">
                Participation in customer surveys or contests; and
              </li>
              <li className="pl-1">
                Facilitation in the delivery of our Services and to respond to your
                inquiries.
              </li>
            </Bullets>

            <Subheading>Sources of Personal Information</Subheading>
            <p>
              Learn more about the sources of personal information we collect in
              &ldquo;
              <Ref id="infocollect">WHAT INFORMATION DO WE COLLECT?</Ref>&rdquo;
            </p>

            <Subheading>How We Use and Share Personal Information</Subheading>
            <p>
              Learn more about how we use your personal information in the section,
              &ldquo;
              <Ref id="infouse">HOW DO WE PROCESS YOUR INFORMATION?</Ref>&rdquo;
            </p>
            <p>
              <Term>Will your information be shared with anyone else?</Term>
            </p>
            <p>
              We may disclose your personal information with our service providers
              pursuant to a written contract between us and each service provider.
              Learn more about how we disclose personal information to in the
              section, &ldquo;
              <Ref id="whoshare">
                WHEN AND WITH WHOM DO WE SHARE YOUR PERSONAL INFORMATION?
              </Ref>
              &rdquo;
            </p>
            <p>
              We may use your personal information for our own business purposes,
              such as for undertaking internal research for technological
              development and demonstration. This is not considered to be
              &ldquo;selling&rdquo; of your personal information.
            </p>
            <p>
              We have not sold or shared any personal information to third parties
              for a business or commercial purpose in the preceding twelve (12)
              months. We have disclosed the following categories of personal
              information to third parties for a business or commercial purpose in
              the preceding twelve (12) months: {DISCLOSED_CATEGORIES}
            </p>
            <p>
              The categories of third parties to whom we disclosed personal
              information for a business or commercial purpose can be found under
              &ldquo;
              <Ref id="whoshare">
                WHEN AND WITH WHOM DO WE SHARE YOUR PERSONAL INFORMATION?
              </Ref>
              &rdquo;
            </p>

            <Subheading>Your Rights</Subheading>
            <p>
              You have rights under certain US state data protection laws. However,
              these rights are not absolute, and in certain cases, we may decline
              your request as permitted by law. These rights include:
            </p>
            <Bullets>
              <li className="pl-1">
                <Term>Right to know</Term> whether or not we are processing your
                personal data
              </li>
              <li className="pl-1">
                <Term>Right to access</Term> your personal data
              </li>
              <li className="pl-1">
                <Term>Right to correct</Term> inaccuracies in your personal data
              </li>
              <li className="pl-1">
                <Term>Right to request</Term> the deletion of your personal data
              </li>
              <li className="pl-1">
                <Term>Right to obtain a copy</Term> of the personal data you
                previously shared with us
              </li>
              <li className="pl-1">
                <Term>Right to non-discrimination</Term> for exercising your rights
              </li>
              <li className="pl-1">
                <Term>Right to opt out</Term> of the processing of your personal
                data if it is used for targeted advertising (or sharing as defined
                under California&rsquo;s privacy law), the sale of personal data, or
                profiling in furtherance of decisions that produce legal or
                similarly significant effects (&ldquo;profiling&rdquo;)
              </li>
            </Bullets>
            <p>
              Depending upon the state where you live, you may also have the
              following rights:
            </p>
            <Bullets>
              <li className="pl-1">
                Right to access the categories of personal data being processed (as
                permitted by applicable law, including the privacy law in Minnesota)
              </li>
              <li className="pl-1">
                Right to obtain a list of the categories of third parties to which
                we have disclosed personal data (as permitted by applicable law,
                including the privacy law in California, Delaware, and Maryland)
              </li>
              <li className="pl-1">
                Right to obtain a list of specific third parties to which we have
                disclosed personal data (as permitted by applicable law, including
                the privacy law in Minnesota and Oregon)
              </li>
              <li className="pl-1">
                Right to obtain a list of third parties to which we have sold
                personal data (as permitted by applicable law, including the privacy
                law in Connecticut)
              </li>
              <li className="pl-1">
                Right to review, understand, question, and depending on where you
                live, correct how personal data has been profiled (as permitted by
                applicable law, including the privacy law in Connecticut and
                Minnesota)
              </li>
              <li className="pl-1">
                Right to limit use and disclosure of sensitive personal data (as
                permitted by applicable law, including the privacy law in
                California)
              </li>
              <li className="pl-1">
                Right to opt out of the collection of sensitive data and personal
                data collected through the operation of a voice or facial
                recognition feature (as permitted by applicable law, including the
                privacy law in Florida)
              </li>
            </Bullets>

            <Subheading>How to Exercise Your Rights</Subheading>
            <p>
              To exercise these rights, you can contact us by visiting{" "}
              <Term>{DSAR_PORTAL}</Term>, by telegram: {TELEGRAM_HANDLE}, or by
              referring to the contact details at the bottom of this document.
            </p>
            <p>
              Under certain US state data protection laws, you can designate an
              authorized agent to make a request on your behalf. We may deny a
              request from an authorized agent that does not submit proof that they
              have been validly authorized to act on your behalf in accordance with
              applicable laws.
            </p>

            <Subheading>Request Verification</Subheading>
            <p>
              Upon receiving your request, we will need to verify your identity to
              determine you are the same person about whom we have the information
              in our system. We will only use personal information provided in your
              request to verify your identity or authority to make the request.
              However, if we cannot verify your identity from the information
              already maintained by us, we may request that you provide additional
              information for the purposes of verifying your identity and for
              security or fraud-prevention purposes.
            </p>
            <p>
              If you submit the request through an authorized agent, we may need to
              collect additional information to verify your identity before
              processing your request and the agent will need to provide a written
              and signed permission from you to submit such request on your behalf.
            </p>

            <Subheading>Appeals</Subheading>
            <p>
              Under certain US state data protection laws, if we decline to take
              action regarding your request, you may appeal our decision by
              emailing us at{" "}
              <a href={`mailto:${CONTACT_EMAIL}`} className={linkClassName}>
                {CONTACT_EMAIL}
              </a>
              . We will inform you in writing of any action taken or not taken in
              response to the appeal, including a written explanation of the reasons
              for the decisions. If your appeal is denied, you may submit a
              complaint to your state attorney general.
            </p>

            <Subheading>
              California &ldquo;Shine The Light&rdquo; Law
            </Subheading>
            <p>
              California Civil Code Section 1798.83, also known as the &ldquo;Shine
              The Light&rdquo; law, permits our users who are California residents
              to request and obtain from us, once a year and free of charge,
              information about categories of personal information (if any) we
              disclosed to third parties for direct marketing purposes and the
              names and addresses of all third parties with which we shared personal
              information in the immediately preceding calendar year. If you are a
              California resident and would like to make such a request, please
              submit your request in writing to us by using the contact details
              provided in the section &ldquo;
              <Ref id="contact">HOW CAN YOU CONTACT US ABOUT THIS NOTICE?</Ref>
              &rdquo;
            </p>
          </Section>

          <Section
            id="policyupdates"
            number="14"
            title="Do we make updates to this notice?"
          >
            <InShort>
              <em>
                Yes, we will update this notice as necessary to stay compliant with
                relevant laws.
              </em>
            </InShort>
            <p>
              We may update this Privacy Notice from time to time. The updated
              version will be indicated by an updated &ldquo;Revised&rdquo; date at
              the top of this Privacy Notice. If we make material changes to this
              Privacy Notice, we may notify you either by prominently posting a
              notice of such changes or by directly sending you a notification. We
              encourage you to review this Privacy Notice frequently to be informed
              of how we are protecting your information.
            </p>
          </Section>

          <Section
            id="contact"
            number="15"
            title="How can you contact us about this notice?"
          >
            <p>
              If you have questions or comments about this notice, you may email us
              at{" "}
              <a href={`mailto:${NOTICE_EMAIL}`} className={linkClassName}>
                {NOTICE_EMAIL}
              </a>{" "}
              or contact us by post at:
            </p>
            <address className="not-italic leading-[1.7]">
              Netherite AI
              <br />
              Jizzakh
              <br />
              Jizzakh 130100
              <br />
              Uzbekistan
            </address>
          </Section>

          <Section
            id="request"
            number="16"
            title="How can you review, update, or delete the data we collect from you?"
          >
            <p>
              Based on the applicable laws of your country or state of residence in
              the US, you may have the right to request access to the personal
              information we collect from you, details about how we have processed
              it, correct inaccuracies, or delete your personal information. You may
              also have the right to withdraw your consent to our processing of your
              personal information. These rights may be limited in some
              circumstances by applicable law. To request to review, update, or
              delete your personal information, please visit:{" "}
              <Term>{DSAR_PORTAL}</Term>.
            </p>
          </Section>
        </div>
      </main>

      <footer className="border-t border-border px-6 py-8 text-xs text-muted-foreground sm:px-14">
        © 2026 <span className="inline-block translate-y-[0.22em] text-[1.6em] leading-none font-brand">NETHERITE</span>
      </footer>
    </div>
  );
}
