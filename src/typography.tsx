import { Children, type ReactNode } from "react";

export function FullStop() {
  return <span className="full-stop">.</span>;
}

// Sentence punctuation only: dots within email addresses, URLs and amounts stay intact.
export function FullStops({ children }: { children: ReactNode }) {
  return Children.map(children, (child) =>
    typeof child === "string"
      ? child
          .split(/(\.(?=[\s”’"')\]]|$))/u)
          .map((part, index) =>
            part === "." ? <FullStop key={index} /> : part,
          )
      : child,
  );
}

export function PieceTitle({ name }: { name: string }) {
  const words = name.replace(/\.$/, "").trim().split(/\s+/);
  const last = words.pop();
  return (
    <>
      {words.length ? (
        <>
          {words.join(" ")}
          <br />
          <em>
            {last}
            <FullStop />
          </em>
        </>
      ) : (
        <>
          {last}
          <FullStop />
        </>
      )}
    </>
  );
}
