# Smart Finance

Prywatna aplikacja do budżetu domowego na telefon (PWA). Wersja **0.5.0**.
Dane zapisują się **tylko w Twoim telefonie** — nic nie trafia na serwer.

Plan techniczny i kolejne etapy: [docs/PLAN.md](docs/PLAN.md)

## Co działa
- Start: bilans miesiąca, majątek netto, ile zostało do zapłaty, wydatki wg kategorii, ostatnie transakcje
- Dodawanie przychodów, wydatków i transferów; szybki tekst („Paliwo 250 zł dzisiaj”); ostatnie operacje jednym dotknięciem
- Zwroty, tagi, oznaczenie „cykliczna”, inne waluty (zapisywane osobno, bez przeliczania)
- Kategorie i podkategorie (edycja, ukrywanie, słowa kluczowe)
- Plan miesiąca (zakładka Miesiąc): wpływy (rodzaj, opis, kwota, dzień) i „Do zapłaty”; ✓/✕; odhaczenie dodaje transakcję (przychód/wydatek), odznaczenie ją usuwa; kopiowanie z poprzedniego miesiąca z podglądem (odznacz, popraw kwoty)
- Kalendarz po dotknięciu nazwy miesiąca: widok miesiąca (dni z kropkami, szczegóły dnia) i roku (bilans/plan każdego miesiąca)
- Plany: „Do kupienia” (cena, priorytet, termin, zgromadzone, kredyt, zwrot inwestycji) z analizą: dane rzeczywiste / szacunki / założenia
- Asystent AI (Gemini): pytania o finanse; klucz tylko w telefonie; do AI idą wyłącznie zagregowane sumy
- Majątek: oszczędności i inwestycje (lokata, IKE, IKZE, PPK, ETF, obligacje, krypto, inne) z opisem, sumą, wpłatą i wypłatą
- Kredyty: spłaty, stan przed/po w danym miesiącu, postęp spłaty
- Konta bieżące z saldem początkowym, majątek netto (aktywa − zobowiązania)
- Analiza (Plany → Analiza): 6 miesięcy na wykresie, średnie 3/6/12 mies., porównanie z poprzednim miesiącem i rokiem wcześniej
- Kopia zapasowa JSON, przywracanie, eksport CSV (polski Excel), kosz z „Cofnij”
- Ustawienia: 8 kolorów aplikacji, jasny/ciemny motyw, rozmiar tekstu, tryb prywatny (rozmyte kwoty, przycisk z okiem), domyślne konto, wibracja
- Przytrzymanie kafelka otwiera menu: transakcja (edytuj, duplikuj, usuń), rachunek (zapłacone, kopiuj na następny miesiąc, duplikuj, usuń), konto (wpłata/wypłata/spłata, historia, edytuj, archiwizuj), karta na stronie startowej (wyżej, niżej, ukryj)
- Własny układ strony startowej: 9 kart do wyboru (w tym Szybkie dodawanie, Oszczędności, Kredyty, Do kupienia), dowolna kolejność
- Działa offline, instalacja na Androidzie

## Wdrożenie na GitHub Pages (bez terminala)

1. Wejdź na github.com → **+** (prawy górny róg) → **New repository**.
2. Nazwa: `smart-finance`, zaznacz **Public**, kliknij **Create repository**.
3. Rozpakuj ZIP (na Androidzie: aplikacja **Pliki** → dotknij ZIP → **Rozpakuj**). Wszystkie pliki aplikacji są w jednym folderze, bez podfolderów.
4. W repozytorium: **Add file** → **Upload files** → **choose your files** → zaznacz **wszystkie pliki** naraz → **Commit changes**. (Jeśli na telefonie nie widać „Add file”, włącz w menu przeglądarki „Wersja na komputer”.)
   Foldery `docs` i `tests` są opcjonalne — aplikacja działa bez nich.
5. **Settings** → **Pages** → w „Branch” wybierz `main` i folder `/ (root)` → **Save**.
6. Po 1–2 minutach aplikacja będzie pod adresem: `https://<twoj-login>.github.io/smart-finance/`

## Instalacja na telefonie (Android)
1. Otwórz powyższy adres w Edge lub Chrome.
2. Menu **⋯** → **Dodaj do telefonu** / **Zainstaluj aplikację**.
3. Uruchamiaj ikonę „Finanse” z ekranu głównego.

Pierwsze kroki: **Majątek** → dotknij konta → wpisz aktualne saldo. Potem dodawaj transakcje przyciskiem **+**.

## Aktualizacja aplikacji
Podmień zmienione pliki w repozytorium (Add file → Upload files). W pliku `sw.js` zwiększ numer `VERSION`, żeby telefon pobrał nową wersję. Twoje dane zostają nienaruszone.

## Bezpieczeństwo i kopie
- Repozytorium jest publiczne, ale zawiera tylko kod — **żadnych danych ani kluczy**.
- Dane są w pamięci przeglądarki telefonu. Wyczyszczenie danych przeglądarki lub utrata telefonu = utrata danych. **Rób kopię zapasową** (Ustawienia → Zrób kopię zapasową) i przechowuj plik np. na Google Drive.
- Nie wrzucaj plików kopii (`smart-finance-kopia-*.json`) do repozytorium.

## Testy (dla programisty / AI)
Wymaga Node.js 18+: `node --test tests/*.test.js`
