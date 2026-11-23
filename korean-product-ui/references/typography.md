# 한글 타이포그래피

영문 기준으로 만든 스타일을 그대로 쓰면 한글 화면은 거의 항상 어딘가 어색해진다.
아래는 그 차이를 메우는 기본값이다. 프로젝트에 디자인 시스템이 있으면 그쪽 값이 우선이다.

## 글꼴

- 기본은 **Pretendard**. 시스템 글꼴(Apple SD Gothic Neo, 맑은 고딕)과 굵기·폭이 비슷해서 대체돼도 덜 튄다.
  ```css
  font-family: "Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, system-ui,
    "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif;
  ```
  웹에서는 dynamic subset CSS를 쓴다(필요한 글자만 내려받는다).
  `https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css`
- 다른 인상이 필요할 때: **SUIT**(조금 더 기하학적), **Wanted Sans**(제목이 단단함). 모두 무료·상업 사용 가능.
  한 화면에 한글 글꼴은 하나만 쓴다.
- `font-family: Inter, sans-serif`처럼 한글 글꼴이 빠진 스택은 한글이 기기 기본 글꼴로 떨어져
  윈도우·맥·안드로이드에서 모양이 제각각이 된다. 검사기의 `ko-font-stack`이 이걸 잡는다.

## 줄바꿈

한글은 글자마다 줄이 바뀔 수 있어서, 폭이 좁으면 "결제하기"가 "결제|하기"로 쪼개진다. 실서비스에서 가장 먼저 눈에 띄는 어색함이다.

```css
body { word-break: keep-all; overflow-wrap: break-word; }
h1, h2, h3 { text-wrap: balance; }
```

- `keep-all`은 어절(띄어쓰기 단위)을 지킨다. 긴 URL·영문 토큰이 넘치지 않게 `overflow-wrap: break-word`를 같이 준다.
- 제목은 `text-wrap: balance`로 둘째 줄에 한 단어만 남는 걸 막는다.
- 버튼·탭·칩처럼 한 줄이어야 하는 곳은 `white-space: nowrap`을 주고 폭이 모자라면 문구를 줄인다.
- 검사기의 `ko-midword-break`는 실제로 그려진 글자 위치를 보고 어절 중간 줄바꿈을 찾는다. 화면 폭마다 결과가 다르므로 모바일·데스크톱을 둘 다 본다.

## 크기·줄 간격·자간

| 쓰임 | 크기(px) | 굵기 | 줄 간격 | 자간 |
|---|---|---|---|---|
| 큰 제목(앱 화면 제목, 웹 히어로) | 26–40 | 700 | 1.3 | -0.02em ~ -0.03em |
| 섹션 제목 | 18–22 | 700 | 1.4 | -0.01em ~ -0.02em |
| 본문 | 15–17 | 400–500 | 1.5–1.6 | 0 ~ -0.01em |
| 보조 설명 | 13–14 | 400 | 1.5 | 0 |
| 캡션·라벨 | 12–13 | 500 | 1.4 | 0 |

- 한글은 같은 크기의 영문보다 꽉 차 보인다. 본문 줄 간격 1.5 아래로 내리면 답답하다(`ko-line-height`).
- 큰 한글 제목은 자간을 조금 좁혀야 글자 사이가 벌어져 보이지 않는다(`ko-heading-tracking`).
- 12px 아래 한글은 획이 뭉개진다. 약관·법적 고지도 12px 이상(`ko-small-text`).
- 굵기는 400·500·700 세 단계면 충분하다. 300 이하 얇은 한글은 화면에서 흐리다.

## 숫자

- 금액·수량은 천 단위 쉼표: `12,000원`, `1,204명`. 쉼표 없는 `45000원`은 바로 티가 난다(`num-comma`).
- 금액이 나란히 놓이는 곳(가격표, 내역)은 `font-variant-numeric: tabular-nums`로 자릿수를 맞춘다.
- 날짜는 맥락에 맞게 짧게: 목록에서는 `11월 23일 (월)`, 시간은 `오후 3:00` 또는 `15:00` 중 하나로 통일.
- 단위는 숫자에 붙인다: `3개`, `20분`, `4.8점`. 영문 단위(km, kg)는 한 칸 띄우지 않아도 된다.

## 줄 길이

본문 한 줄은 한글 40자 안팎이 읽기 편하다. `ch` 단위는 숫자 0의 폭이라 한글 글자 수와 다르니,
`max-width: 36rem` 정도로 잡고 실제 화면에서 세어 본다.

## 출처

- Pretendard: https://github.com/orioncactus/pretendard
- SUIT: https://sun.fo/suit/ · Wanted Sans: https://github.com/wanteddev/wanted-sans
- WCAG 1.4.8(CJK 줄 길이 40자), 1.4.12(텍스트 간격)
