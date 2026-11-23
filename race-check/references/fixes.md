# 고치는 방법

위에서부터 먼저 검토한다. 아래로 갈수록 움직이는 부품이 늘어난다.

## 1. 조건부 UPDATE 한 문장

읽고 판단하고 쓰는 세 단계를 DB 한 문장으로 합친다. 가장 단순하고 가장 많이 맞는다.

```sql
UPDATE events SET remaining = remaining - 1
WHERE id = :id AND remaining > 0;
-- 영향받은 행이 0이면 매진
```

- JPA: `@Modifying @Query("update Event e set e.remaining = e.remaining - 1 where e.id = :id and e.remaining > 0")`로 쓰고 반환값(int)을 본다. 엔티티를 읽어 `event.decrease()` 후 저장하는 방식은 이 보장이 없다.
- 같은 트랜잭션에서 주문 행도 넣는다. 둘 중 하나가 실패하면 함께 롤백된다.
- `remaining = :계산한값`처럼 앱에서 계산한 값을 쓰면 다시 잃어버린 갱신이 된다. 반드시 `remaining - 1`.

## 2. DB 제약

중복은 조회해서 막지 말고 제약으로 막는다.

```sql
CREATE UNIQUE INDEX orders_event_user ON orders (event_id, user_id);
ALTER TABLE events ADD CONSTRAINT remaining_non_negative CHECK (remaining >= 0);
```

- 제약 위반 예외를 잡아 409로 바꾼다(PostgreSQL `23505`, MySQL `1062`).
- MySQL은 8.0.16부터 CHECK 제약을 실제로 검사한다. 그 전 버전은 문법만 받고 무시하니 조건부 UPDATE로 막는다.
- 소프트 삭제(`deleted_at`)가 있으면 PostgreSQL은 부분 유니크 인덱스(`WHERE deleted_at IS NULL`)를 쓴다. MySQL에는 부분 인덱스가 없어서, 삭제되지 않은 행에만 값이 들어가는 생성 열(generated column)을 만들어 그 열에 유니크 인덱스를 건다.
- 같은 요청이 재시도로 두 번 오는 경우(결제 등)는 요청마다 멱등 키를 받아 유니크 제약을 건다.

## 3. 행 잠금 (비관적 잠금)

여러 행을 읽고 복잡하게 판단해야 해서 한 문장으로 못 쓸 때.

```sql
SELECT * FROM seats WHERE id = :id FOR UPDATE;  -- 다른 트랜잭션은 여기서 기다린다
```

- JPA: `@Lock(LockModeType.PESSIMISTIC_WRITE)`. 잠금은 그 트랜잭션이 끝날 때 풀린다. 잠금 조회만 짧은 트랜잭션(예: repository 메서드의 기본 트랜잭션)에서 하고 판단과 저장을 그 밖에서 하면, 저장 시점에는 이미 잠금이 없다. 조회부터 저장까지를 서비스 메서드 하나의 `@Transactional` 안에 둔다. 트랜잭션이 아예 없으면 Hibernate는 보통 `TransactionRequiredException`을 던진다.
- 여러 행을 잠글 때는 항상 같은 순서(ID 오름차순)로 잠가 교착을 피한다.
- 대기 시간 제한을 건다(PostgreSQL `lock_timeout`, MySQL `innodb_lock_wait_timeout`, JPA `jakarta.persistence.lock.timeout`).
- 인기 상품 하나에 요청이 몰리면 모두 한 줄로 서게 되어 처리량이 떨어진다. 그때는 1번이나 대기열을 검토한다.

## 4. 낙관적 잠금

충돌이 드문 곳(프로필 수정, 장바구니). 선착순처럼 충돌이 대부분인 곳에는 맞지 않는다.

```sql
UPDATE accounts SET balance = :new, version = version + 1
WHERE id = :id AND version = :readVersion;  -- 0행이면 다시 읽고 재시도
```

- JPA: `@Version` 필드. `OptimisticLockException`을 잡아 몇 번까지 재시도할지 정한다.
- 재시도가 무한히 돌지 않게 횟수를 제한한다.

## 5. Redis

DB 앞에서 먼저 걸러야 할 만큼 요청이 많을 때(대기열, 선착순 입장).

- 재고 차감은 `DECR` 결과가 0 이상인지 본다. 음수면 `INCR`로 되돌리고 매진 처리.
- 확인과 차감을 함께 해야 하면 Lua 스크립트 하나로 묶는다. `GET` 후 `SET`은 같은 경쟁 상태다.
- Redis에서 통과한 요청도 DB에서 1·2번으로 한 번 더 막는다. Redis와 DB가 어긋나면 DB가 기준이다.

## 쓰면 안 되는 것

- **애플리케이션 메모리 락**(`synchronized`, `ReentrantLock`, Node의 뮤텍스): 서버가 두 대 이상이거나 프로세스가 여럿이면 소용없다. 로컬 단일 프로세스 시험에서는 통과해 보여서 더 위험하다.
- **격리 수준만 올리기**: PostgreSQL `REPEATABLE READ`는 스냅샷 격리라 쓰기 충돌 시 직렬화 오류를 내고, MySQL InnoDB `REPEATABLE READ`는 일반 SELECT로 읽은 뒤 계산해서 쓰는 잃어버린 갱신을 막지 못한다. 이름이 같아도 DB마다 보장이 다르다. 올린다면 직렬화 오류 재시도까지 같이 만든다.
- **`@Transactional`만 붙이기**: 트랜잭션은 원자성을 주지만 다른 트랜잭션이 같은 행을 동시에 읽는 걸 막지 않는다. 읽고-판단하고-쓰는 코드는 트랜잭션 안에서도 그대로 경쟁한다.
- **조회 후 존재 확인으로 중복 막기**: `existsBy...` 후 `save`는 두 요청이 동시에 "없음"을 본다. 2번의 유니크 제약을 쓴다.
